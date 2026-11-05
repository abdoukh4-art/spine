import type {
  Alert,
  EnrichmentResult,
  PlaybookDefinition,
  RunEventType,
  RunStatus,
  ScoreExplanation,
  Step,
  StepType,
} from '@spine/shared-schema';

/**
 * Core types of the durable execution engine (ADR-0010).
 *
 * A run is an append-only list of {@link RunEventRecord}s. Everything else (its status,
 * which step is next, what each step returned) is *derived* from that list by the pure
 * {@link reduce} function. Nothing about a run is ever kept only in memory.
 */

/** One stored fact about a run. `seq` starts at 1 and has no gaps. */
export interface RunEventRecord {
  seq: number;
  type: RunEventType;
  stepId: string | null;
  payload: Record<string, unknown>;
  /** ISO-8601 timestamp. */
  occurredAt: string;
}

/** An event the executor wants to append; the store keeps it exactly as given. */
export type NewRunEvent = RunEventRecord;

/** The alert data a run works on, captured once when the run starts (a snapshot). */
export interface RunSnapshot {
  alert: Alert;
  score: ScoreExplanation | null;
  enrichments: EnrichmentResult[];
}

/** Payload of the `run.started` event: the run's immutable inputs. */
export interface RunStartedPayload extends RunSnapshot {
  playbookId: string;
  playbookVersion: number;
  alertId: string;
  dryRun: boolean;
  trigger: 'auto' | 'manual';
  startedBy: string | null;
}

/** Derived per-step status. Mirrors `StepState.status` in the shared schema. */
export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'waiting'
  | 'compensated';

/** Everything the engine knows about one step of one run. */
export interface StepRunState {
  stepId: string;
  type: StepType;
  status: StepStatus;
  /** Number of attempts started so far. */
  attempts: number;
  /** Idempotency key of the latest started attempt. */
  idempotencyKey: string | null;
  output?: unknown;
  error?: string;
  /** True once the step has failed and will not be retried any more. */
  finalFailure: boolean;
  /** Set while a retry is scheduled: the attempt that will run and when it may start. */
  retry: { attempt: number; notBefore: string } | null;
  /** The successor chosen when the step finished (`null` = the path ends here). */
  next: string | null | undefined;
  startedAt: string | null;
  finishedAt: string | null;
}

/** An approval the run is waiting for. */
export interface PendingApproval {
  stepId: string;
  approvalId: string;
  expiresAt: string;
  requestedAt: string;
}

/** Progress of the saga's backward recovery (compensation). */
export interface CompensationProgress {
  started: boolean;
  /** Steps whose compensation succeeded, in the order it ran. */
  succeeded: string[];
  /** Steps whose compensation failed, in the order it ran. */
  failed: string[];
}

/** The state of a run, derived from its events by {@link reduce}. */
export interface RunState {
  status: RunStatus;
  /** Inputs from `run.started`, or null for an empty log. */
  inputs: RunStartedPayload | null;
  steps: Record<string, StepRunState>;
  /** Where the single execution token is. `null` = the path has ended. */
  currentStepId: string | null;
  /** Steps that finished successfully, in completion order (drives compensation order). */
  completedSteps: string[];
  pendingApproval: PendingApproval | null;
  /** The step whose final failure stopped the run (`onFailure: fail`), if any. */
  failure: { stepId: string; error: string } | null;
  compensation: CompensationProgress;
  lastSeq: number;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Total time spent waiting for humans, in milliseconds. */
  approvalWaitMs: number;
}

/** The read-only context that conditions and templates are evaluated against (ADR-0013). */
export interface EvaluationContext {
  alert: Alert | null;
  score: ScoreExplanation | null;
  enrichment: EnrichmentSummary;
  steps: Record<string, { output: unknown }>;
  run: {
    id: string;
    playbookId: string;
    playbookVersion: number;
    dryRun: boolean;
    trigger: 'auto' | 'manual';
  };
}

/** Enrichment results plus convenient aggregates for conditions. */
export interface EnrichmentSummary {
  results: EnrichmentResult[];
  /** Verdicts per indicator type, e.g. `enrichment.verdicts.url` → `['malicious','benign']`. */
  verdicts: Record<string, string[]>;
  /** Indicator values with at least one `malicious` verdict. */
  malicious: string[];
  /** Indicator values whose worst verdict is `suspicious`. */
  suspicious: string[];
}

/** What the engine wants to happen next. Produced by {@link decide}. */
export type NextAction =
  | { kind: 'ExecuteStep'; stepId: string; attempt: number; resume: boolean }
  | { kind: 'ScheduleRetry'; stepId: string; attempt: number; delayMs: number }
  | { kind: 'WaitForRetry'; stepId: string; attempt: number; notBefore: string }
  | { kind: 'RequestApproval'; stepId: string }
  | { kind: 'WaitForApproval'; stepId: string; approvalId: string; expiresAt: string }
  | { kind: 'SkipStep'; stepId: string; reason: string }
  | { kind: 'Compensate'; stepId: string }
  | { kind: 'Finish'; status: 'succeeded' | 'failed' | 'compensated' }
  | { kind: 'Halt'; status: RunStatus };

/** Context passed to a step handler. */
export interface StepContext {
  runId: string;
  alert: Alert | null;
  dryRun: boolean;
  /** Aborted when the step times out or the host cancels the work. Pass it to I/O. */
  signal: AbortSignal;
  /** `${runId}:${stepId}:${attempt}` — identical when a crashed attempt is re-executed. */
  idempotencyKey: string;
  attempt: number;
  /** The evaluation context, for templates and step inputs. */
  input: EvaluationContext;
}

/** Implementation of one step type (an adapter in the host application). */
export interface StepHandler<S extends Step = Step> {
  /** Performs the step. The return value is stored as the step's output (must be JSON). */
  execute(step: S, ctx: StepContext): Promise<unknown>;
  /** Undoes a successful execution during compensation (saga). */
  compensate?(step: S, ctx: StepContext, originalOutput: unknown): Promise<unknown>;
}

/** Handlers keyed by step type. `branch` is evaluated by the engine itself. */
export type StepHandlers = Partial<Record<Exclude<StepType, 'branch'>, StepHandler>>;

/** A stored run: its pinned definition plus its event log. */
export interface LoadedRun {
  definition: PlaybookDefinition;
  events: RunEventRecord[];
}

/** Port: durable storage of run events with optimistic concurrency (ADR-0010). */
export interface RunStore {
  load(runId: string): Promise<LoadedRun | null>;
  /**
   * Appends events whose `seq` continue from `expectedSeq`. If another writer appended
   * first, rejects with {@link ConcurrencyError} and stores nothing.
   */
  append(runId: string, expectedSeq: number, events: readonly NewRunEvent[]): Promise<void>;
}

/** Port: the current time. */
export interface EngineClock {
  now(): Date;
}

/** Observations for metrics and logs; all optional and never allowed to fail the run. */
export interface ExecutorHooks {
  onStepFinished?(info: {
    runId: string;
    stepId: string;
    type: StepType;
    status: 'succeeded' | 'failed';
    durationMs: number;
    attempt: number;
  }): void;
}

/** Everything {@link advance} needs from the outside world. */
export interface ExecutorPorts {
  store: RunStore;
  handlers: StepHandlers;
  clock: EngineClock;
  hooks?: ExecutorHooks;
  /** Aborts in-flight handlers, e.g. on worker shutdown. */
  signal?: AbortSignal;
  /** Safety guard against runaway loops (default 200). */
  maxIterations?: number;
}

/** How a call to {@link advance} ended. */
export type AdvanceOutcome =
  | { kind: 'terminal'; status: RunStatus }
  | { kind: 'waiting_approval'; approvalId: string; expiresAt: string }
  | { kind: 'retry_scheduled'; notBefore: string; delayMs: number }
  | { kind: 'yielded'; reason: 'max_iterations' | 'aborted' }
  | { kind: 'not_found' };

/** Result of {@link advance}. */
export interface AdvanceResult {
  outcome: AdvanceOutcome;
  /** Loop iterations used (load → reduce → decide → act). */
  iterations: number;
  /** Optimistic-concurrency conflicts that were resolved by reloading. */
  conflicts: number;
  lastSeq: number;
}
