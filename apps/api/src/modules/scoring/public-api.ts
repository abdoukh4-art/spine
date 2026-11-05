import type { Alert, EnrichmentResult, Ruleset, ScoreExplanation } from '@spine/shared-schema';

/** Public API of the Scoring module. Other modules may import ONLY this file. */
export interface ScoringPublicApi {
  /** Latest stored score explanation for an alert, or null when not scored yet. */
  getForAlert(alertId: string): Promise<ScoreExplanation | null>;
  /** Pure: computes an explanation with the active ruleset, without persisting. */
  preview(alert: Alert, enrichments: readonly EnrichmentResult[]): ScoreExplanation;
  /** Computes, persists and returns the score (used by the playbook `score` step). */
  scoreAndStore(alert: Alert, enrichments: readonly EnrichmentResult[]): Promise<ScoreExplanation>;
  /** The ruleset currently in effect. */
  activeRuleset(): Ruleset;
}
