import type { LoadedRun, RunEventRecord, RunSnapshot, RunStore } from '@spine/playbook-engine';
import type {
  Alert,
  AlertStatus,
  Approval,
  ApprovalStatus,
  EnrichmentResult,
  Indicator,
  Page,
  PlaybookDefinition,
  PlaybookRecord,
  PlaybookSummary,
  Role,
  RunStatus,
  RunSummary,
  ScoreExplanation,
  SimulatedAction,
} from '@spine/shared-schema';
import type { Db } from '../../../platform/db/database.js';
import type { DomainEventDraft } from '../domain/run-view.js';

/**
 * Ports of the playbooks module (ADR-0002). Use cases depend only on these interfaces;
 * `adapters/` implements them (Postgres, BullMQ, simulated integrations) and the module's
 * `index.ts` wires the two together.
 */

// ---------------------------------------------------------------------------
// Gateways to other modules (wired in composition.ts; placeholders until Phase 2)
// ---------------------------------------------------------------------------

/** Enrichment module, used by the `enrich` step. Must not throw for provider failures. */
export interface EnrichmentGateway {
  enrich(
    alert: Alert,
    options: { providers?: string[]; signal: AbortSignal },
  ): Promise<EnrichmentResult[]>;
}

/** Scoring module, used by the `score` step. `null` means "scoring unavailable". */
export interface ScoringGateway {
  score(
    alert: Alert,
    enrichments: readonly EnrichmentResult[],
    options: { persist: boolean },
  ): Promise<ScoreExplanation | null>;
}

/** Alerts module, used by the `set_status` step. Illegal transitions are reported, not thrown. */
export interface AlertStatusGateway {
  setStatus(alertId: string, status: AlertStatus): Promise<{ changed: boolean; reason?: string }>;
}

/** Alerts + enrichment + scoring snapshot of one alert, for manual runs. */
export interface AlertSnapshotGateway {
  get(alertId: string): Promise<RunSnapshot | null>;
}

/** One explicit audit entry. */
export interface AuditEntry {
  actorId: string | null;
  actorType: 'user' | 'system';
  action: string;
  targetType: string;
  targetId: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

/**
 * Explicit, domain-significant audit entries (the auth module's `AuditRecorder`). Pass
 * `executor` (an open transaction) to commit the entry atomically with the state change.
 */
export interface AuditGateway {
  record(entry: AuditEntry, executor?: Db): Promise<void>;
}

/** Everything the module needs from other modules. */
export interface PlaybooksGateways {
  enrichment: EnrichmentGateway;
  scoring: ScoringGateway;
  alertStatus: AlertStatusGateway;
  alertSnapshot: AlertSnapshotGateway;
  audit: AuditGateway;
}

// ---------------------------------------------------------------------------
// Simulated response actions (ADR-0018)
// ---------------------------------------------------------------------------

/** Options every response action receives. Same idempotency key → same result. */
export interface ActionOptions {
  idempotencyKey: string;
  runId: string;
  stepId: string;
  dryRun: boolean;
  signal: AbortSignal;
}

/** Perimeter firewall. */
export interface FirewallPort {
  block(
    request: { indicators: Indicator[]; durationMinutes: number; alertId: string },
    options: ActionOptions,
  ): Promise<{ blockId: string; blocked: Indicator[]; expiresAt: string }>;
  unblock(
    request: { blockId: string; indicators: Indicator[] },
    options: ActionOptions,
  ): Promise<{ blockId: string; unblocked: Indicator[] }>;
}

/** Ticketing system. */
export interface TicketingPort {
  create(
    request: { queue: string; priority: string; summary: string; alertId: string },
    options: ActionOptions,
  ): Promise<{ ticketId: string }>;
  close(
    request: { ticketId: string; reason: string },
    options: ActionOptions,
  ): Promise<{ ticketId: string; closed: boolean }>;
}

/** Team chat. */
export interface ChatPort {
  post(
    request: { channel: string; message: string },
    options: ActionOptions,
  ): Promise<{ messageId: string }>;
}

/** Records what a dry run *would* have changed on an alert. */
export interface StatusPreviewPort {
  record(
    request: { alertId: string; status: AlertStatus },
    options: ActionOptions,
  ): Promise<{ previewed: true }>;
}

/** The response-action ports a run uses. */
export interface ResponseActions {
  firewall: FirewallPort;
  ticketing: TicketingPort;
  chat: ChatPort;
  statusPreview: StatusPreviewPort;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** A new immutable playbook version. */
export interface NewPlaybookVersion {
  definition: PlaybookDefinition;
  source: string;
  enabled: boolean;
  createdBy: string | null;
}

/** Playbook definitions, versioned and immutable per `(id, version)`. */
export interface PlaybookRepository {
  listLatest(): Promise<PlaybookSummary[]>;
  get(id: string, version?: number): Promise<PlaybookRecord | null>;
  /** Highest stored version of a playbook, or null when unknown. */
  latestVersion(id: string): Promise<number | null>;
  /** Inserts a version; returns false if `(id, version)` already exists. */
  insertIfMissing(version: NewPlaybookVersion): Promise<boolean>;
  /** Enables/disables the latest version. Returns the new summary, or null if unknown. */
  setEnabled(id: string, enabled: boolean): Promise<PlaybookSummary | null>;
  /** Latest version of every enabled playbook (for trigger matching). */
  enabledLatest(): Promise<PlaybookDefinition[]>;
}

/** A run to create, with its first (`run.started`) event. */
export interface NewRun {
  id: string;
  playbookId: string;
  playbookVersion: number;
  alertId: string;
  dryRun: boolean;
  trigger: 'auto' | 'manual';
  startedBy: string | null;
  started: RunEventRecord;
}

/** Filter + page of the runs list. */
export interface RunListFilter {
  playbookId?: string;
  alertId?: string;
  status?: RunStatus;
  limit: number;
  cursor?: string;
}

/** Event-sourced runs + their projection. Extends the engine's {@link RunStore}. */
export interface RunRepository extends RunStore {
  /** Creates the run; returns false when an automatic run already exists (idempotency). */
  create(run: NewRun): Promise<boolean>;
  load(runId: string): Promise<LoadedRun | null>;
  summary(runId: string): Promise<RunSummary | null>;
  list(filter: RunListFilter): Promise<Page<RunSummary>>;
  forAlert(alertId: string): Promise<RunSummary[]>;
  /** Runs a worker should be working on: not terminal and not waiting for a human. */
  resumable(): Promise<{ id: string; lastSeq: number }[]>;
}

/** A stored approval plus the fields the use cases need. */
export type ApprovalRecord = Approval;

/** A new approval request. */
export interface NewApproval {
  id: string;
  runId: string;
  stepId: string;
  alertId: string;
  playbookId: string;
  approverRole: Role;
  prompt: string;
  requestedAt: string;
  expiresAt: string;
}

/** Human approval requests. */
export interface ApprovalRepository {
  /** Inserts unless `(runId, stepId)` exists; returns the stored approval either way. */
  createIfMissing(approval: NewApproval): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | null>;
  /** Reads and row-locks an approval (inside a unit of work). */
  getForUpdate(id: string): Promise<ApprovalRecord | null>;
  markDecided(
    id: string,
    decision: {
      status: Exclude<ApprovalStatus, 'pending'>;
      decidedBy: string | null;
      comment: string | null;
      at: string;
    },
  ): Promise<ApprovalRecord>;
  /** Marks the pending approvals of a run as expired (used on cancel). */
  expirePendingForRun(runId: string, at: string): Promise<void>;
  list(filter: {
    status?: ApprovalStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<ApprovalRecord>>;
  /** IDs of pending approvals whose deadline has passed. */
  dueForExpiry(now: string, limit: number): Promise<string[]>;
}

/** What the simulated adapters "did". */
export interface SimulatedActionReader {
  list(filter: {
    kind?: SimulatedAction['kind'];
    limit: number;
    cursor?: string;
  }): Promise<Page<SimulatedAction>>;
}

/** Repositories bound to one database transaction, plus the outbox. */
export interface PlaybooksUnitOfWork {
  playbooks: PlaybookRepository;
  runs: RunRepository;
  approvals: ApprovalRepository;
  /** Publishes domain events in this transaction (transactional outbox, ADR-0009). */
  publish(events: readonly DomainEventDraft[]): Promise<void>;
  /** Records an audit entry in this transaction (it commits or rolls back with it). */
  audit(entry: AuditEntry): Promise<void>;
}

/** Entry point to persistence: auto-commit repositories, or an explicit unit of work. */
export interface PlaybooksStore extends PlaybooksUnitOfWork {
  transaction<T>(fn: (uow: PlaybooksUnitOfWork) => Promise<T>): Promise<T>;
  simulatedActions: SimulatedActionReader;
}

// ---------------------------------------------------------------------------
// Queue and observability
// ---------------------------------------------------------------------------

/**
 * Schedules executor jobs (BullMQ in production). Idempotent per `(runId, seq)`, or per
 * `(runId, seq, notBefore)` for delayed retry jobs.
 */
export interface RunQueue {
  enqueue(
    runId: string,
    seq: number,
    options?: { delayMs: number; notBefore: string },
  ): Promise<void>;
}

/** Metric hooks for the executor (implemented with OpenTelemetry in adapters). */
export interface ExecutionObserver {
  stepFinished(info: { type: string; status: 'succeeded' | 'failed'; durationMs: number }): void;
}
