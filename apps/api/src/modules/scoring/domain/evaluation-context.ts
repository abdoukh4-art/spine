import {
  ASSET_CRITICALITIES,
  FAILED_ENRICHMENT_STATUSES,
  VERDICTS,
  type Alert,
  type AssetCriticality,
  type EnrichmentResult,
  type IndicatorType,
  type Verdict,
} from '@spine/shared-schema';

/** The asset the alert is about, as the asset inventory describes it. */
export interface AssetSummary {
  hostname: string;
  criticality: AssetCriticality;
  owner: string | null;
  businessUnit: string | null;
  tags: string[];
}

/**
 * Enrichment results boiled down to the facts rules care about (ADR-0043). Rule authors
 * write `enrichment.asset.criticality`, not "find the result whose provider is
 * asset-inventory and whose status is ok, then read data.criticality".
 * Every list is de-duplicated and sorted, so the context (and the explanation's evidence)
 * is deterministic.
 */
export interface EnrichmentSummary {
  /** Distinct verdicts from successful lookups, most severe first (`malicious`, `suspicious`, `benign`, `unknown`). */
  verdicts: Verdict[];
  /** Highest reputation score (0–100) seen, or null when no reputation data came back. */
  maxReputationScore: number | null;
  /** Values of indicators judged malicious, e.g. `["203.0.113.66", "evil.example"]`. */
  maliciousIndicators: string[];
  /** Types of the malicious indicators, e.g. `["domain", "ipv4"]`. */
  maliciousIndicatorTypes: IndicatorType[];
  /** Values of indicators judged suspicious. */
  suspiciousIndicators: string[];
  /** Union of the tags from all reputation results, e.g. `["c2", "authorized-scanner"]`. */
  reputationTags: string[];
  /** The most critical asset found for the host or its IPs, or null when none was found. */
  asset: AssetSummary | null;
  /**
   * Union of the tags of EVERY asset found (source and destination alike). `asset` keeps only
   * the most critical one, so a scan *from* an authorized scanner *to* a critical server
   * would otherwise lose the scanner's `authorized-scanner` tag.
   */
  assetTags: string[];
  geo: {
    /** ISO 3166-1 alpha-2 country codes of the alert's public IPs. */
    countries: string[];
    /** Autonomous system numbers of the alert's public IPs. */
    asns: number[];
    /** True if any IP is a Tor exit node. */
    isTor: boolean;
    /** The IPs that are Tor exit nodes. */
    torIps: string[];
  };
  /** Providers with at least one failed lookup (timeout, error, circuit_open, rejected). */
  failedProviders: string[];
}

/** The read-only object scoring conditions are evaluated against: `{ alert, enrichment }`. */
export interface EvaluationContext {
  alert: Alert;
  enrichment: EnrichmentSummary;
}

/** Names of the `enrichment.*` keys, used to validate rule field paths at load time. */
export const ENRICHMENT_SUMMARY_KEYS: readonly (keyof EnrichmentSummary)[] = [
  'verdicts',
  'maxReputationScore',
  'maliciousIndicators',
  'maliciousIndicatorTypes',
  'suspiciousIndicators',
  'reputationTags',
  'asset',
  'assetTags',
  'geo',
  'failedProviders',
];

/** De-duplicates, then sorts (numbers numerically, strings by code unit). */
const sortedUnique = <T extends string | number>(values: Iterable<T>): T[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : 1)); // never equal after the Set

/** Builds the evaluation context. Pure and deterministic: same input, same context. */
export function buildEvaluationContext(
  alert: Alert,
  enrichments: readonly EnrichmentResult[],
): EvaluationContext {
  const ok = enrichments.filter((r) => r.status === 'ok');
  const verdictOf = (r: EnrichmentResult): Verdict | undefined =>
    r.verdict ?? (r.data?.kind === 'reputation' ? r.data.verdict : undefined);
  const withVerdict = (v: Verdict) => ok.filter((r) => verdictOf(r) === v);

  const reputation = ok.flatMap((r) => (r.data?.kind === 'reputation' ? [r.data] : []));
  const geo = ok.flatMap((r) =>
    r.data?.kind === 'geo' ? [{ ip: r.indicator.value, ...r.data }] : [],
  );
  const present = new Set(ok.map(verdictOf));

  return {
    alert,
    enrichment: {
      verdicts: VERDICTS.filter((v) => present.has(v)),
      maxReputationScore:
        reputation.length === 0 ? null : Math.max(...reputation.map((d) => d.score)),
      maliciousIndicators: sortedUnique(withVerdict('malicious').map((r) => r.indicator.value)),
      maliciousIndicatorTypes: sortedUnique(withVerdict('malicious').map((r) => r.indicator.type)),
      suspiciousIndicators: sortedUnique(withVerdict('suspicious').map((r) => r.indicator.value)),
      reputationTags: sortedUnique(reputation.flatMap((d) => d.tags)),
      asset: mostCriticalAsset(ok),
      assetTags: sortedUnique(ok.flatMap((r) => (r.data?.kind === 'asset' ? r.data.tags : []))),
      geo: {
        countries: sortedUnique(geo.flatMap((g) => (g.country ? [g.country] : []))),
        asns: sortedUnique(geo.flatMap((g) => (g.asn === undefined ? [] : [g.asn]))),
        isTor: geo.some((g) => g.isTor),
        torIps: sortedUnique(geo.filter((g) => g.isTor).map((g) => g.ip)),
      },
      failedProviders: sortedUnique(
        enrichments
          .filter((r) => FAILED_ENRICHMENT_STATUSES.includes(r.status))
          .map((r) => r.provider),
      ),
    },
  };
}

function mostCriticalAsset(ok: readonly EnrichmentResult[]): AssetSummary | null {
  let best: AssetSummary | null = null;
  for (const r of ok) {
    if (r.data?.kind !== 'asset') continue;
    const rank = ASSET_CRITICALITIES.indexOf(r.data.criticality);
    if (best && ASSET_CRITICALITIES.indexOf(best.criticality) >= rank) continue;
    best = {
      hostname: r.data.hostname,
      criticality: r.data.criticality,
      owner: r.data.owner ?? null,
      businessUnit: r.data.businessUnit ?? null,
      tags: [...r.data.tags],
    };
  }
  return best;
}
