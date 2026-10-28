import { z } from 'zod';
import { SeveritySchema, TimestampSchema, type Severity } from './common.js';
import { ConditionSchema } from './condition.js';

/** One rule in a versioned scoring ruleset (ADR-0015). */
export const ScoringRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  description: z.string().min(1).max(300),
  when: ConditionSchema,
  points: z.number().int().min(-100).max(100),
  /** Field path whose value is quoted as evidence when the rule matches. */
  evidenceField: z.string().max(200).optional(),
});
export type ScoringRule = z.infer<typeof ScoringRuleSchema>;

export const RulesetSchema = z.object({
  version: z.number().int().min(1),
  description: z.string().max(500).optional(),
  baseline: z.object({
    fromSeverity: z.record(SeveritySchema, z.number().int().min(0).max(100)),
  }),
  rules: z.array(ScoringRuleSchema).max(500),
});
export type Ruleset = z.infer<typeof RulesetSchema>;

/** One contributing factor in a score explanation. Factors sum to the raw (unclamped) score. */
export const ScoreFactorSchema = z.object({
  ruleId: z.string(),
  description: z.string(),
  points: z.number().int(),
  evidence: z.string().max(500).optional(),
});
export type ScoreFactor = z.infer<typeof ScoreFactorSchema>;

export const ScoreExplanationSchema = z.object({
  score: z.number().int().min(0).max(100),
  rawScore: z.number().int(),
  severity: SeveritySchema,
  rulesetVersion: z.number().int(),
  factors: z.array(ScoreFactorSchema).min(1),
  /** Providers that failed for this alert; a low score may be low partly because of them. */
  dataGaps: z.array(z.string()).default([]),
  computedAt: TimestampSchema,
});
export type ScoreExplanation = z.infer<typeof ScoreExplanationSchema>;

/** Fixed score → severity bands (ADR-0015). */
export function severityFromScore(score: number): Severity {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  if (score >= 20) return 'low';
  return 'informational';
}
