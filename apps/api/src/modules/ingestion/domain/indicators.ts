import {
  INDICATOR_TYPES,
  type CanonicalAlert,
  type Indicator,
  type IndicatorType,
} from '@spine/shared-schema';
import { canonicalIp } from './ip.js';

/**
 * Indicator (observable) extraction and normalization (ADR-0032).
 *
 * Why so careful? Indicators drive three things downstream: enrichment lookups (one per
 * indicator × provider), scoring rules, and the deduplication fingerprint. `EVIL.example.`,
 * `evil[.]example` and `evil.example` must therefore become *one* value, and garbage must be
 * dropped instead of failing the whole alert: a sensor that sends one bad IP still saw something.
 *
 * Properties (proved by property tests in indicators.test.ts):
 * - idempotent: normalize(normalize(x)) = normalize(x);
 * - no duplicates; order-independent (the output is sorted);
 * - never throws, whatever the input; at most {@link MAX_INDICATORS} entries.
 */
export const MAX_INDICATORS = 256;
const MAX_VALUE_LENGTH = 2048;

/** Defanging patterns analysts use so that IOCs in tickets aren't clickable. */
const REFANG_RULES: readonly (readonly [RegExp, string])[] = [
  [/hxxp/gi, 'http'],
  [/\[\.\]|\(\.\)|\{\.\}|\[dot\]/gi, '.'],
  [/\[@\]|\(@\)|\[at\]/gi, '@'],
  [/\[:\/\/\]/g, '://'],
  [/\[:\]/g, ':'],
];

/**
 * Re-arms a defanged value (`hxxps://evil[.]example` → `https://evil.example`). Applied until
 * nothing changes, because one replacement can reveal another (`[[.].]` → `[.]` → `.`); without
 * the loop the function would not be idempotent.
 */
export function refang(value: string): string {
  let current = value;
  for (let i = 0; i <= value.length; i += 1) {
    let next = current;
    for (const [pattern, replacement] of REFANG_RULES) next = next.replace(pattern, replacement);
    if (next === current) return current;
    current = next;
  }
  return current;
}

const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

function toAsciiHost(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- deliberately testing for non-ASCII
  if (/^[\x00-\x7f]*$/.test(value)) return value;
  try {
    return new URL(`http://${value}/`).hostname; // IDN → punycode (WHATWG URL, no I/O)
  } catch {
    return null;
  }
}

/** Validates and canonicalizes a DNS name. `minLabels` = 2 for domains, 1 for hostnames. */
function dnsName(raw: string, minLabels: number): string | null {
  let v = refang(raw).trim().toLowerCase();
  if (v.endsWith('.')) v = v.slice(0, -1);
  const ascii = toAsciiHost(v);
  if (ascii === null || ascii.length === 0 || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < minLabels || !labels.every((l) => LABEL.test(l))) return null;
  if (labels.length > 1 && /^\d+$/.test(labels[labels.length - 1] ?? '')) return null;
  return ascii;
}

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ftp:']);

function url(raw: string): string | null {
  try {
    const parsed = new URL(refang(raw).trim());
    if (!WEB_PROTOCOLS.has(parsed.protocol) || parsed.hostname === '') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

const HASH_LENGTH: Partial<Record<IndicatorType, number>> = { md5: 32, sha1: 40, sha256: 64 };
const EMAIL = /^([^\s@]{1,64})@([^\s@]+)$/;

function email(raw: string): string | null {
  const m = EMAIL.exec(refang(raw).trim().toLowerCase());
  if (!m?.[1] || !m[2]) return null;
  const domain = dnsName(m[2], 2);
  return domain ? `${m[1]}@${domain}` : null;
}

function ipIndicator(raw: string): Indicator | null {
  const ip = canonicalIp(refang(raw).trim());
  return ip ? { type: ip.family, value: ip.value } : null;
}

function nameIndicator(type: 'domain' | 'hostname', raw: string): Indicator | null {
  // An IP sent as a "domain"/"hostname" is still a useful observable: reclassify it.
  const asIp = ipIndicator(raw);
  if (asIp) return asIp;
  const value = dnsName(raw, type === 'domain' ? 2 : 1);
  return value ? { type, value } : null;
}

function normalizeByType(type: IndicatorType, raw: string): Indicator | null {
  switch (type) {
    case 'ipv4':
    case 'ipv6':
      return ipIndicator(raw);
    case 'domain':
    case 'hostname':
      return nameIndicator(type, raw);
    case 'url': {
      const value = url(raw);
      return value ? { type, value } : null;
    }
    case 'email': {
      const value = email(raw);
      return value ? { type, value } : null;
    }
    case 'username': {
      const value = raw.trim();
      // eslint-disable-next-line no-control-regex -- control characters are never part of a user name
      return value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value)
        ? { type, value }
        : null;
    }
    case 'md5':
    case 'sha1':
    case 'sha256': {
      const value = raw.trim().toLowerCase();
      const length = HASH_LENGTH[type] ?? 0;
      return value.length === length && /^[a-f0-9]+$/.test(value) ? { type, value } : null;
    }
  }
}

/**
 * Normalizes one indicator; returns null when the value is invalid for its type.
 * Never throws (the input is typed loosely on purpose: it may come straight from a sensor).
 */
export function normalizeIndicator(indicator: { type: string; value: unknown }): Indicator | null {
  if (typeof indicator.value !== 'string' || indicator.value.length > MAX_VALUE_LENGTH * 2)
    return null;
  if (!(INDICATOR_TYPES as readonly string[]).includes(indicator.type)) return null;
  const result = normalizeByType(indicator.type as IndicatorType, indicator.value);
  return result && result.value.length <= MAX_VALUE_LENGTH ? result : null;
}

function compareIndicators(a: Indicator, b: Indicator): number {
  const byType = INDICATOR_TYPES.indexOf(a.type) - INDICATOR_TYPES.indexOf(b.type);
  if (byType !== 0) return byType;
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

/** Normalizes, drops invalid values, de-duplicates, sorts and caps a list of indicators. */
export function normalizeIndicators(
  indicators: readonly { type: string; value: unknown }[],
): Indicator[] {
  const unique = new Map<string, Indicator>();
  for (const candidate of indicators) {
    const n = normalizeIndicator(candidate);
    if (n) unique.set(`${n.type}\u0000${n.value}`, n);
  }
  return [...unique.values()].sort(compareIndicators).slice(0, MAX_INDICATORS);
}

/** The domain (or IP) part of a URL, as an indicator candidate. */
function urlHost(value: string): { type: string; value: string } | null {
  try {
    const host = new URL(refang(value).trim()).hostname;
    return host ? { type: 'domain', value: host } : null;
  } catch {
    return null;
  }
}

/**
 * Derives indicators from an alert's entity fields (host, user, network, file, url) plus its
 * explicit `indicators`, then normalizes them. URLs also contribute their host as a domain.
 */
export function extractIndicators(alert: CanonicalAlert): Indicator[] {
  const derived: { type: string; value: unknown }[] = [];
  const push = (type: string, value: unknown): void => {
    if (value !== undefined) derived.push({ type, value });
  };
  push('hostname', alert.host?.hostname);
  for (const ip of alert.host?.ips ?? []) push('ipv4', ip);
  push('username', alert.user?.name);
  push('email', alert.user?.email);
  push('ipv4', alert.network?.sourceIp);
  push('ipv4', alert.network?.destinationIp);
  push('sha256', alert.file?.sha256);
  push('md5', alert.file?.md5);
  push('url', alert.url);
  const all = [...derived, ...alert.indicators];
  const urlHosts = all
    .filter((i) => i.type === 'url' && typeof i.value === 'string')
    .map((i) => urlHost(i.value as string))
    .filter((h): h is { type: string; value: string } => h !== null);
  return normalizeIndicators([...all, ...urlHosts]);
}
