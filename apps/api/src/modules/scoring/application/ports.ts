import type { ScoreExplanation } from '@spine/shared-schema';
import type { NewDomainEvent } from '../../../platform/events/types.js';

/** Writes that must commit atomically with the `alert.scored` event (ADR-0009). */
export interface ScoringTransaction {
  /**
   * Stores the score for (alert, ruleset version) **if it is new or materially different**
   * (anything but `computedAt` changed) and comes from an equal-or-newer enrichment snapshot
   * than the stored one (ADR-0042).
   * @returns true when a row was inserted or updated, i.e. when `alert.scored` must be published.
   */
  saveIfChanged(
    alertId: string,
    explanation: ScoreExplanation,
    sourceOccurredAt: Date,
  ): Promise<boolean>;
  /** Publishes domain events in this transaction (outbox). */
  publish(events: readonly NewDomainEvent[]): Promise<void>;
}

/** Port: the module's persistence. */
export interface ScoreRepository {
  transaction<T>(work: (tx: ScoringTransaction) => Promise<T>): Promise<T>;
  /** The most recently computed score for the alert (any ruleset version), or null. */
  latestForAlert(alertId: string): Promise<ScoreExplanation | null>;
}
