import type { Indicator, MitreMapping, Severity } from '@spine/shared-schema';
import { canonicalIp } from '../ip.js';
import { err, normalizationError } from '../result.js';
import { parseCef, type CefRecord } from './cef-parser.js';
import { validateCanonical, type NormalizeContext, type Normalizer } from './canonical.js';
import { classifyCategory, compact, port, str, toIsoTimestamp, zipMitre } from './fields.js';

/**
 * CEF (syslog) line → canonical alert (ADR-0031). Parsing lives in `cef-parser.ts`; this
 * file only maps the ArcSight dictionary keys to Spine's fields.
 */

/**
 * CEF severity is 0–10 (or a word). Bands follow the ArcSight convention:
 * 0–3 low, 4–6 medium, 7–8 high, 9–10 critical.
 */
export function cefSeverity(value: string): Severity {
  const v = value.trim().toLowerCase();
  if (/^\d{1,2}$/.test(v)) {
    const n = Number(v);
    if (n <= 3) return 'low';
    if (n <= 6) return 'medium';
    if (n <= 8) return 'high';
    if (n <= 10) return 'critical';
  }
  const words: Record<string, Severity> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    'very-high': 'critical',
    'very high': 'critical',
    critical: 'critical',
    informational: 'informational',
    info: 'informational',
  };
  return words[v] ?? 'medium';
}

function ip(value: string | undefined): string | undefined {
  return value ? canonicalIp(value)?.value : undefined;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Custom string fields (`cs1`…`cs6` + `cs1Label`…) become labels keyed by their label. */
function customLabels(ext: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prefix of ['cs', 'cn', 'flexString']) {
    for (let i = 1; i <= 6; i += 1) {
      const value = ext[`${prefix}${i}`];
      if (value === undefined) continue;
      const label = ext[`${prefix}${i}Label`] ?? `${prefix}${i}`;
      out[label.slice(0, 100)] = value.slice(0, 1024);
    }
  }
  return out;
}

function labels(rec: CefRecord): Record<string, string> {
  const ext = rec.extensions;
  const fixed: Record<string, string | undefined> = {
    'cef.signature_id': rec.signatureId || undefined,
    'cef.device_version': rec.deviceVersion || undefined,
    'cef.action': ext.act,
    'cef.outcome': ext.outcome,
    'cef.category': ext.cat,
    'cef.app': ext.app,
    'cef.device_host': ext.dvchost,
    'cef.device_address': ext.dvc,
    'cef.reason': ext.reason,
  };
  const out = customLabels(ext);
  for (const [k, v] of Object.entries(fixed)) if (v) out[k] = v.slice(0, 1024);
  return out;
}

function mitre(custom: Record<string, string>): MitreMapping[] {
  const find = (re: RegExp): string[] =>
    Object.entries(custom)
      .filter(([k]) => re.test(k))
      .flatMap(([, v]) => v.split(/[,;\s]+/).filter(Boolean));
  return zipMitre({
    tacticIds: find(/mitre.?tactic.?(id)?$/i),
    techniqueIds: find(/mitre.?technique.?(id)?$/i),
  });
}

function fileFields(ext: Record<string, string>): { file?: object; extra: Indicator[] } {
  const hash = ext.fileHash?.trim().toLowerCase();
  const sha256 = hash && /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
  const md5 = hash && /^[a-f0-9]{32}$/.test(hash) ? hash : undefined;
  const extra: Indicator[] =
    hash && /^[a-f0-9]{40}$/.test(hash) ? [{ type: 'sha1', value: hash }] : [];
  const file = compact({ name: str(ext.fname, 1024), path: str(ext.filePath, 4096), sha256, md5 });
  return Object.keys(file).length > 0 ? { file, extra } : { extra };
}

function webUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Maps a parsed record to a canonical candidate (still to be validated). */
function toCandidate(rec: CefRecord, line: string, occurredAt: string): Record<string, unknown> {
  const ext = rec.extensions;
  const userName = str(ext.duser, 255) ?? str(ext.suser, 255);
  const hostname = str(ext.dhost, 255) ?? str(ext.shost, 255);
  const extraIndicators: Indicator[] = [];
  if (ext.duser && ext.suser)
    extraIndicators.push({ type: 'username', value: ext.suser.slice(0, 255) });
  if (ext.dhost && ext.shost)
    extraIndicators.push({ type: 'hostname', value: ext.shost.slice(0, 255) });
  const { file, extra } = fileFields(ext);
  const network = compact({
    sourceIp: ip(ext.src),
    sourcePort: port(ext.spt),
    destinationIp: ip(ext.dst),
    destinationPort: port(ext.dpt),
    protocol: str(ext.proto, 32)?.toLowerCase(),
  });
  const custom = customLabels(ext);
  return compact({
    source: compact({
      vendor: rec.deviceVendor.slice(0, 100),
      product: rec.deviceProduct.slice(0, 100),
      sourceAlertId: str(ext.externalId, 256),
    }),
    title: rec.name.slice(0, 512),
    description: str(ext.msg, 8192),
    category: classifyCategory([ext.cat, rec.name]),
    severity: cefSeverity(rec.severity),
    occurredAt,
    host: hostname ? { hostname } : undefined,
    user: userName
      ? compact({
          name: userName,
          email: EMAIL.test(userName) ? userName.toLowerCase() : undefined,
        })
      : undefined,
    network: Object.keys(network).length > 0 ? network : undefined,
    file,
    url: webUrl(ext.request),
    indicators: [...extraIndicators, ...extra],
    mitre: mitre(custom),
    labels: labels(rec),
    raw: { format: 'cef', line },
  });
}

function eventTime(rec: CefRecord, context: NormalizeContext | undefined): string | undefined {
  const ext = rec.extensions;
  return (
    toIsoTimestamp(ext.rt) ??
    toIsoTimestamp(ext.start) ??
    toIsoTimestamp(ext.end) ??
    (context?.receivedAt ? toIsoTimestamp(context.receivedAt) : undefined)
  );
}

/** The `cef` normalizer. Input: one CEF line (string), optionally with a syslog prefix. */
export const normalizeCef: Normalizer = (raw, context) => {
  if (typeof raw !== 'string') {
    return err(normalizationError('parse_error', 'CEF input must be a text line'));
  }
  const parsed = parseCef(raw);
  if (!parsed.ok) return parsed;
  const rec = parsed.value;
  if (!rec.name)
    return err(normalizationError('missing_field', 'CEF Name (header field 6) is empty'));
  if (!rec.deviceVendor || !rec.deviceProduct) {
    return err(
      normalizationError('missing_field', 'CEF Device Vendor and Device Product are required'),
    );
  }
  const occurredAt = eventTime(rec, context);
  if (!occurredAt) {
    return err(
      normalizationError('missing_field', 'no event time (rt/start/end) and no receivedAt'),
    );
  }
  return validateCanonical(toCandidate(rec, raw, occurredAt));
};
