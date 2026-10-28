import type { Alert, AlertStatus, Severity } from '@spine/shared-schema';
import type { DbExecutor } from '../../platform/events/types.js';

export { OpenAlertExistsError } from './application/errors.js';

/** Public API of the Alerts/Cases module. Other modules may import ONLY this file. */
export interface AlertsPublicApi {
  /** Returns the canonical alert snapshot, or null when unknown. */
  get(alertId: string): Promise<Alert | null>;
  /**
   * Changes an alert's status on behalf of an actor (a user, or `null` for automation such
   * as a playbook `set_status` step). Validates the transition and emits `alert.status_changed`.
   * Setting the status the alert already has is a no-op (safe for at-least-once retries).
   * @throws ConflictError on an illegal transition. @throws NotFoundError for an unknown alert.
   */
  setStatus(alertId: string, to: AlertStatus, actorId: string | null): Promise<void>;

  // ---- ingestion-facing (Phase 1, additive). All run in the CALLER's transaction. ----

  /**
   * Finds the OPEN alert (not resolved/false_positive) with this fingerprint and locks its
   * row until the caller's transaction ends, so concurrent duplicates serialize (ADR-0033).
   */
  findOpenByFingerprint(
    trx: DbExecutor,
    fingerprint: string,
  ): Promise<{ alertId: string; duplicateCount: number } | null>;
  /** Records one more occurrence of an open alert: `duplicate_count + 1`, `last_seen_at`. */
  recordDuplicate(
    trx: DbExecutor,
    alertId: string,
    seenAt: string,
  ): Promise<{ duplicateCount: number; lastSeenAt: string }>;
  /**
   * Stores a brand-new alert (status `new`). Emits nothing: `alert.ingested` belongs to Ingestion.
   * @throws OpenAlertExistsError when a concurrent transaction created the same open alert first.
   */
  create(trx: DbExecutor, alert: Alert): Promise<void>;

  // ---- reporting (Phase 2, additive) ----

  /** Lifecycle timestamps of alerts received in [from, to), for the Metrics module (ADR-0026). */
  timesReceivedBetween(from: Date, to: Date): Promise<AlertTimesRow[]>;
}

/** One alert's lifecycle timestamps, as the Metrics module needs them. */
export interface AlertTimesRow {
  occurredAt: Date;
  receivedAt: Date;
  /** First close time, or null while the alert is open (including after a reopen). */
  resolvedAt: Date | null;
  /** Score-derived severity, falling back to the source severity before scoring. */
  severity: Severity;
}
