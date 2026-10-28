import type { Indicator, IndicatorType } from '@spine/shared-schema';

/** The parts of an alert that enrichment looks at. A full `Alert` satisfies it. */
export interface EnrichmentInput {
  indicators: readonly Indicator[];
  host?: { hostname?: string | undefined; ips?: readonly string[] | undefined } | undefined;
}

/** Types whose values are case-insensitive, so `EVIL.example` and `evil.example` are one lookup. */
const CASE_INSENSITIVE: ReadonlySet<IndicatorType> = new Set([
  'domain',
  'hostname',
  'email',
  'md5',
  'sha1',
  'sha256',
  'ipv6',
]);

/** Canonical form of an indicator value: trimmed, lower-cased where case carries no meaning. */
export function normalizeIndicator(indicator: Indicator): Indicator {
  const trimmed = indicator.value.trim();
  return {
    type: indicator.type,
    value: CASE_INSENSITIVE.has(indicator.type) ? trimmed.toLowerCase() : trimmed,
  };
}

/**
 * Everything to look up for an alert: its indicators plus the affected host (hostname and
 * IPs), which the asset inventory needs even when the source didn't list them as
 * indicators. Normalized and de-duplicated, in first-seen order (deterministic output).
 */
export function lookupTargets(input: EnrichmentInput): Indicator[] {
  const candidates: Indicator[] = [...input.indicators];
  const host = input.host;
  if (host?.hostname) candidates.push({ type: 'hostname', value: host.hostname });
  for (const ip of host?.ips ?? []) {
    candidates.push({ type: ip.includes(':') ? 'ipv6' : 'ipv4', value: ip });
  }
  const seen = new Set<string>();
  const targets: Indicator[] = [];
  for (const candidate of candidates) {
    const indicator = normalizeIndicator(candidate);
    if (indicator.value.length === 0) continue;
    const key = `${indicator.type}\u0000${indicator.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(indicator);
  }
  return targets;
}
