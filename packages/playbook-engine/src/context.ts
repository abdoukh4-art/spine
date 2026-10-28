import type { EnrichmentResult, ScoreExplanation } from '@spine/shared-schema';
import type { EnrichmentSummary, EvaluationContext, RunState } from './types.js';

/**
 * Builds the read-only evaluation context for conditions and templates (ADR-0013):
 * `{ alert, score, enrichment, steps: { <id>: { output } }, run }`.
 *
 * It is derived from the event log only, so a replay always sees the same context.
 * `enrich` and `score` steps refresh `enrichment` and `score`: their outputs carry
 * `{ enrichments }` and `{ score }` respectively, and the latest one wins.
 */
export function buildEvaluationContext(runId: string, state: RunState): EvaluationContext {
  const inputs = state.inputs;
  let enrichments: EnrichmentResult[] = inputs?.enrichments ?? [];
  let score: ScoreExplanation | null = inputs?.score ?? null;
  const steps: Record<string, { output: unknown }> = {};

  for (const stepId of state.completedSteps) {
    const step = state.steps[stepId];
    if (!step) continue;
    steps[stepId] = { output: step.output };
    if (step.type === 'enrich' && hasArray(step.output, 'enrichments')) {
      enrichments = step.output.enrichments as EnrichmentResult[];
    }
    if (step.type === 'score' && hasObject(step.output, 'score')) {
      score = step.output.score as ScoreExplanation;
    }
  }

  return {
    alert: inputs?.alert ?? null,
    score,
    enrichment: summarizeEnrichment(enrichments),
    steps,
    run: {
      id: runId,
      playbookId: inputs?.playbookId ?? '',
      playbookVersion: inputs?.playbookVersion ?? 0,
      dryRun: inputs?.dryRun ?? false,
      trigger: inputs?.trigger ?? 'manual',
    },
  };
}

/** Verdict severity order, worst first. */
const VERDICT_RANK: Record<string, number> = {
  malicious: 3,
  suspicious: 2,
  unknown: 1,
  benign: 0,
};

/** Rank of a verdict (higher is worse); unknown strings rank like `unknown`. */
export function verdictRank(verdict: string | undefined): number {
  return verdict === undefined ? -1 : (VERDICT_RANK[verdict] ?? 1);
}

/**
 * Aggregates raw enrichment results into shapes the closed predicate language can test,
 * e.g. `{ field: enrichment.verdicts.url, op: contains, value: malicious }`.
 */
export function summarizeEnrichment(results: readonly EnrichmentResult[]): EnrichmentSummary {
  const verdicts: Record<string, string[]> = {};
  const worst = new Map<string, number>();
  for (const r of results) {
    if (r.verdict === undefined) continue;
    const list = verdicts[r.indicator.type] ?? [];
    if (!list.includes(r.verdict)) list.push(r.verdict);
    verdicts[r.indicator.type] = list;
    const rank = verdictRank(r.verdict);
    worst.set(r.indicator.value, Math.max(rank, worst.get(r.indicator.value) ?? -1));
  }
  const malicious: string[] = [];
  const suspicious: string[] = [];
  for (const [value, rank] of worst) {
    if (rank === VERDICT_RANK.malicious) malicious.push(value);
    else if (rank === VERDICT_RANK.suspicious) suspicious.push(value);
  }
  return { results: [...results], verdicts, malicious, suspicious };
}

function hasArray(value: unknown, key: string): value is Record<string, unknown[]> {
  return isRecord(value) && Array.isArray(value[key]);
}

function hasObject(value: unknown, key: string): value is Record<string, object> {
  return isRecord(value) && isRecord(value[key]);
}

/** True for plain (non-array, non-null) objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
