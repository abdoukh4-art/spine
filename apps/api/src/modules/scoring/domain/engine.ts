import {
  evaluateCondition,
  getPath,
  severityFromScore,
  type Alert,
  type EnrichmentResult,
  type Ruleset,
  type ScoreExplanation,
  type ScoreFactor,
} from '@spine/shared-schema';
import { buildEvaluationContext, type EvaluationContext } from './evaluation-context.js';
import { fieldPaths } from './ruleset.js';

/** `ruleId` of the factor every explanation starts with. */
export const BASELINE_RULE_ID = 'baseline';
const MAX_EVIDENCE = 500;

/**
 * The scoring engine (ADR-0015): additive, explainable and deterministic.
 *
 * ```
 * rawScore = baseline(source severity) + Σ points of every matching rule
 * score    = clamp(0, 100, rawScore)       severity = severityFromScore(score)
 * ```
 *
 * The explanation lists **every** factor: the baseline first, then each matching rule in
 * ruleset order, with the value that made it match as evidence. Providers that failed are
 * listed in `dataGaps`, so a low score never hides "low because the provider was down".
 *
 * Pure: no I/O and no clock (`now` is a parameter), so the same inputs always give the same output.
 */
export function score(
  alert: Alert,
  enrichments: readonly EnrichmentResult[],
  ruleset: Ruleset,
  now: Date,
): ScoreExplanation {
  const context = buildEvaluationContext(alert, enrichments);
  const matched: ScoreFactor[] = ruleset.rules
    .filter((rule) => evaluateCondition(rule.when, context))
    .map((rule) => {
      const evidence = evidenceFor(context, rule.evidenceField ?? fieldPaths(rule.when)[0]);
      return {
        ruleId: rule.id,
        description: rule.description,
        points: rule.points,
        ...(evidence === undefined ? {} : { evidence }),
      };
    });
  const factors = [baselineFactor(alert, ruleset, matched.length === 0), ...matched];
  const rawScore = factors.reduce((sum, f) => sum + f.points, 0);
  const clamped = Math.min(100, Math.max(0, rawScore));
  return {
    score: clamped,
    rawScore,
    severity: severityFromScore(clamped),
    rulesetVersion: ruleset.version,
    factors,
    dataGaps: context.enrichment.failedProviders,
    computedAt: now.toISOString(),
  };
}

function baselineFactor(alert: Alert, ruleset: Ruleset, nothingElse: boolean): ScoreFactor {
  const suffix = nothingElse ? '; no scoring rule matched' : '';
  return {
    ruleId: BASELINE_RULE_ID,
    description: `Baseline for source severity "${alert.severity}"${suffix}`,
    points: ruleset.baseline.fromSeverity[alert.severity],
    evidence: `severity=${alert.severity}`,
  };
}

/** The value at `path`, rendered as short text: arrays joined with ", ", objects as JSON. */
export function evidenceFor(
  context: EvaluationContext,
  path: string | undefined,
): string | undefined {
  if (path === undefined) return undefined;
  const value = getPath(context, path);
  if (value === undefined || value === null) return undefined;
  const text = render(value);
  return text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE - 1)}…` : text;
}

function render(value: unknown): string {
  if (Array.isArray(value)) return value.map(render).join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  if (typeof value === 'string') return value;
  return String(value as number | boolean);
}
