import { verdictRank } from '@spine/playbook-engine';
import type { EnrichmentResult, Indicator, IndicatorType } from '@spine/shared-schema';

/** Parameters of a `block_indicator` step that decide what may be blocked. */
export interface BlockPolicy {
  indicatorTypes: readonly IndicatorType[];
  minVerdict: 'malicious' | 'suspicious';
}

/** What a block step will (and will not) block, with the reason for each skip. */
export interface BlockSelection {
  toBlock: Indicator[];
  skipped: { indicator: Indicator; reason: string }[];
}

/**
 * Chooses the indicators a `block_indicator` step may block (ADR-0013, ADR-0018).
 *
 * Blocking is the riskiest automated action, so the rule is conservative: an indicator
 * is blocked only if its type is listed AND its worst reputation verdict across all
 * providers is at least `minVerdict`. Unknown or un-enriched indicators are never blocked.
 */
export function selectIndicatorsToBlock(
  indicators: readonly Indicator[],
  enrichments: readonly EnrichmentResult[],
  policy: BlockPolicy,
): BlockSelection {
  const threshold = verdictRank(policy.minVerdict);
  const selection: BlockSelection = { toBlock: [], skipped: [] };
  const seen = new Set<string>();
  for (const indicator of indicators) {
    const key = `${indicator.type}|${indicator.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!policy.indicatorTypes.includes(indicator.type)) {
      selection.skipped.push({ indicator, reason: `type ${indicator.type} not in indicatorTypes` });
      continue;
    }
    const worst = worstVerdict(indicator, enrichments);
    if (worst === undefined || verdictRank(worst) < threshold) {
      selection.skipped.push({
        indicator,
        reason: `verdict ${worst ?? 'none'} is below ${policy.minVerdict}`,
      });
      continue;
    }
    selection.toBlock.push(indicator);
  }
  return selection;
}

function worstVerdict(
  indicator: Indicator,
  enrichments: readonly EnrichmentResult[],
): string | undefined {
  let worst: string | undefined;
  for (const r of enrichments) {
    if (r.indicator.type !== indicator.type || r.indicator.value !== indicator.value) continue;
    if (r.verdict !== undefined && verdictRank(r.verdict) > verdictRank(worst)) worst = r.verdict;
  }
  return worst;
}
