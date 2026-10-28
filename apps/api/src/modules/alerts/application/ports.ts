import type { AlertTimesRow } from '../public-api.js';
import type {
  Alert,
  AlertListQuery,
  AlertStatus,
  AlertSummary,
  Case,
  CaseListQuery,
  CaseStatus,
  EnrichmentResult,
  Page,
  RunSummary,
  ScoreExplanation,
  Severity,
} from '@spine/shared-schema';
import type { DbExecutor } from '../../../platform/events/types.js';
import type { LifecycleState } from '../domain/status-change.js';

/**
 * Secondary ports of the Alerts/Cases module (ADR-0002). Methods that take a `DbExecutor`
 * run inside the caller's transaction, so a state change and its outbox events commit together.
 */

/** Runs a function inside one database transaction. */
export interface TransactionRunner {
  run<T>(fn: (trx: DbExecutor) => Promise<T>): Promise<T>;
}

/** The mutable lifecycle fields of an alert, as read under a row lock. */
export interface LockedAlert extends LifecycleState {
  id: string;
  fingerprint: string;
  assigneeId: string | null;
  caseId: string | null;
}

/** Fields an update may change. `undefined` = leave as is. */
export interface AlertPatch {
  status?: AlertStatus;
  resolvedAt?: string | null;
  assigneeId?: string | null;
  caseId?: string | null;
  updatedAt: string;
}

/** Persistence of the `alerts` table. */
export interface AlertRepository {
  /** @throws OpenAlertExistsError when an open alert with the same fingerprint exists. */
  insert(trx: DbExecutor, alert: Alert): Promise<void>;
  /** Finds the open alert with this fingerprint and locks its row (`FOR UPDATE`). */
  lockOpenByFingerprint(
    trx: DbExecutor,
    fingerprint: string,
  ): Promise<{ id: string; duplicateCount: number } | null>;
  /** Increments `duplicate_count` and moves `last_seen_at` forward (never backwards). */
  recordDuplicate(
    trx: DbExecutor,
    alertId: string,
    seenAt: string,
  ): Promise<{ duplicateCount: number; lastSeenAt: string }>;
  getAlert(executor: DbExecutor, alertId: string): Promise<Alert | null>;
  getSummary(executor: DbExecutor, alertId: string): Promise<AlertSummary | null>;
  /** Reads the lifecycle fields and locks the row (`FOR UPDATE`); null when unknown. */
  lock(trx: DbExecutor, alertId: string): Promise<LockedAlert | null>;
  /** @throws OpenAlertExistsError when a reopen collides with a newer open alert. */
  update(trx: DbExecutor, alertId: string, patch: AlertPatch): Promise<void>;
  list(query: AlertListQuery): Promise<Page<AlertSummary>>;
  /**
   * Writes `score`/`severity` unless a newer score was already applied (ADR-0038).
   * @returns false when the alert is unknown or the score was stale.
   */
  projectScore(
    alertId: string,
    score: { score: number; severity: Severity; computedAt: string },
  ): Promise<boolean>;
  /** Lifecycle timestamps of alerts received in [from, to) (reporting, ADR-0026). */
  timesReceivedBetween(from: Date, to: Date): Promise<AlertTimesRow[]>;
  /** Ids of the given alerts that exist. */
  existingIds(trx: DbExecutor, alertIds: readonly string[]): Promise<string[]>;
  /** Sets `case_id` for the given alerts (null unlinks; `onlyCaseId` restricts unlinking to one case). */
  setCase(
    trx: DbExecutor,
    alertIds: readonly string[],
    caseId: string | null,
    at: string,
    onlyCaseId?: string,
  ): Promise<void>;
  /** Alert ids per case, for the given cases. */
  alertIdsByCase(executor: DbExecutor, caseIds: readonly string[]): Promise<Map<string, string[]>>;
  summariesForCase(executor: DbExecutor, caseId: string): Promise<AlertSummary[]>;
}

/** A case row without its derived `alertIds`. */
export type CaseRecord = Omit<Case, 'alertIds'>;

/** Persistence of the `cases` table. */
export interface CaseRepository {
  insert(trx: DbExecutor, record: CaseRecord): Promise<void>;
  get(
    executor: DbExecutor,
    caseId: string,
    options?: { lock?: boolean },
  ): Promise<CaseRecord | null>;
  update(
    trx: DbExecutor,
    caseId: string,
    patch: { title?: string; description?: string; status?: CaseStatus; updatedAt: string },
  ): Promise<void>;
  list(query: CaseListQuery): Promise<Page<CaseRecord>>;
}

/**
 * Where the alert detail view gets data owned by OTHER modules (enrichment, scoring,
 * playbooks). A port, so this module never reads their tables (ADR-0002). Wired in
 * composition.ts; a placeholder returns empty data until those modules exist.
 */
export interface AlertDetailSources {
  enrichmentsFor(alertId: string): Promise<EnrichmentResult[]>;
  scoreFor(alertId: string): Promise<ScoreExplanation | null>;
  runsFor(alertId: string): Promise<RunSummary[]>;
}
