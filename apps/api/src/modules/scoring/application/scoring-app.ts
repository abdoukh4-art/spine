import type { Alert, EnrichmentResult, Ruleset, ScoreExplanation } from '@spine/shared-schema';
import type { Clock } from '../../../platform/runtime.js';
import { score } from '../domain/engine.js';
import type { ScoringPublicApi } from '../public-api.js';
import type { ScoreRepository } from './ports.js';

/** Result of scoring one enrichment snapshot. */
export interface ScoredOutcome {
  explanation: ScoreExplanation;
  /** False when nothing changed (redelivery, identical re-enrichment) or the snapshot was stale. */
  published: boolean;
}

/** Collaborators of {@link ScoringApplication}. */
export interface ScoringApplicationDeps {
  ruleset: Ruleset;
  repository: ScoreRepository;
  clock: Clock;
}

/**
 * The scoring use cases: a thin shell around the pure engine (ADR-0015). The only
 * non-pure parts are the clock, the repository and the outbox.
 */
export class ScoringApplication implements ScoringPublicApi {
  constructor(private readonly deps: ScoringApplicationDeps) {}

  /** The ruleset in effect (loaded and validated once at startup, ADR-0046). */
  activeRuleset(): Ruleset {
    return this.deps.ruleset;
  }

  /** Computes an explanation without persisting anything. */
  preview(alert: Alert, enrichments: readonly EnrichmentResult[]): ScoreExplanation {
    return score(alert, enrichments, this.deps.ruleset, this.deps.clock.now());
  }

  /**
   * Scores an enrichment snapshot, stores it and publishes `alert.scored`, in one
   * transaction, but only when the score is new or changed (ADR-0042). Safe to call again
   * with the same snapshot: the second call writes and publishes nothing.
   *
   * @param snapshotAt when the enrichment snapshot was produced (the `alert.enriched`
   *   event's `occurredAt`); older snapshots never overwrite newer scores.
   */
  scoreSnapshot(
    alert: Alert,
    enrichments: readonly EnrichmentResult[],
    snapshotAt: Date,
  ): Promise<ScoredOutcome> {
    const explanation = this.preview(alert, enrichments);
    return this.deps.repository.transaction(async (tx) => {
      const changed = await tx.saveIfChanged(alert.id, explanation, snapshotAt);
      if (changed) {
        await tx.publish([
          {
            type: 'alert.scored',
            aggregateId: alert.id,
            payload: { alert, enrichments: [...enrichments], score: explanation },
          },
        ]);
      }
      return { explanation, published: changed };
    });
  }

  /** Public API: scores with "now" as the snapshot time (playbook `score` step). */
  async scoreAndStore(
    alert: Alert,
    enrichments: readonly EnrichmentResult[],
  ): Promise<ScoreExplanation> {
    return (await this.scoreSnapshot(alert, enrichments, this.deps.clock.now())).explanation;
  }

  /** Latest stored explanation, or null when the alert hasn't been scored yet. */
  getForAlert(alertId: string): Promise<ScoreExplanation | null> {
    return this.deps.repository.latestForAlert(alertId);
  }
}
