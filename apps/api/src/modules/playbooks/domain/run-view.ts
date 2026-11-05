import type { RunEventRecord, RunState } from '@spine/playbook-engine';
import type {
  EventPayload,
  EventType,
  PlaybookDefinition,
  RunStatus,
  StepState,
} from '@spine/shared-schema';

/**
 * Read-side views derived from a run's state: the per-step list shown in the console
 * timeline, the `playbook_runs` projection, and the domain events an append implies.
 * All pure, so the projection can always be rebuilt from the events (ADR-0010).
 */

/** Per-step view for `RunDetail.steps`, in definition order. */
export function toStepStates(definition: PlaybookDefinition, state: RunState): StepState[] {
  return definition.steps.map((step) => {
    const s = state.steps[step.id];
    return {
      stepId: step.id,
      type: step.type,
      status: s?.status ?? 'pending',
      attempts: s?.attempts ?? 0,
      ...(s?.output !== undefined ? { output: s.output } : {}),
      ...(s?.error !== undefined ? { error: s.error } : {}),
      startedAt: s?.startedAt ?? null,
      finishedAt: s?.finishedAt ?? null,
    };
  });
}

/** The denormalized `playbook_runs` columns derived from the state. */
export interface RunProjection {
  status: RunStatus;
  currentStepId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  approvalWaitMs: number;
  lastSeq: number;
}

/** Computes the projection row for a run. */
export function projectionOf(state: RunState): RunProjection {
  return {
    status: state.status,
    currentStepId: state.currentStepId,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    approvalWaitMs: state.approvalWaitMs,
    lastSeq: state.lastSeq,
  };
}

/** Minimal identity of a run needed to build domain events. */
export interface RunIdentity {
  id: string;
  playbookId: string;
  alertId: string;
  dryRun: boolean;
}

/** A domain event to publish through the outbox (ADR-0009). */
export interface DomainEventDraft<T extends EventType = EventType> {
  type: T;
  aggregateId: string;
  payload: EventPayload<T>;
}

/**
 * Maps newly appended run events to the cross-module domain events of the catalog:
 * `approval.requested`, `approval.decided` and `playbook.run.finished`.
 */
export function domainEventsFor(
  run: RunIdentity,
  appended: readonly RunEventRecord[],
  state: RunState,
): DomainEventDraft[] {
  const out: DomainEventDraft[] = [];
  for (const event of appended) {
    const p = event.payload;
    if (event.type === 'approval.requested' && event.stepId !== null) {
      out.push(approvalRequested(run, event.stepId, p));
    } else if (event.type === 'approval.granted' || event.type === 'approval.rejected') {
      out.push(approvalDecided(run, event.type, p));
    } else if (isTerminalEvent(event.type)) {
      out.push(runFinished(run, event, state));
    }
  }
  return out;
}

function approvalRequested(
  run: RunIdentity,
  stepId: string,
  p: Record<string, unknown>,
): DomainEventDraft<'approval.requested'> {
  const approvalId = String(p.approvalId);
  return {
    type: 'approval.requested',
    aggregateId: approvalId,
    payload: {
      approvalId,
      runId: run.id,
      stepId,
      approverRole: p.approverRole === 'admin' ? 'admin' : 'analyst',
      prompt: typeof p.prompt === 'string' ? p.prompt : '',
      expiresAt: String(p.expiresAt),
    },
  };
}

function approvalDecided(
  run: RunIdentity,
  type: 'approval.granted' | 'approval.rejected',
  p: Record<string, unknown>,
): DomainEventDraft<'approval.decided'> {
  const approvalId = String(p.approvalId);
  const decision =
    p.reason === 'timeout' ? 'expired' : type === 'approval.granted' ? 'approved' : 'rejected';
  return {
    type: 'approval.decided',
    aggregateId: approvalId,
    payload: {
      approvalId,
      runId: run.id,
      decision,
      decidedBy: typeof p.decidedBy === 'string' ? p.decidedBy : null,
    },
  };
}

function runFinished(
  run: RunIdentity,
  event: RunEventRecord,
  state: RunState,
): DomainEventDraft<'playbook.run.finished'> {
  const startedAt = state.createdAt ?? event.occurredAt;
  return {
    type: 'playbook.run.finished',
    aggregateId: run.id,
    payload: {
      runId: run.id,
      playbookId: run.playbookId,
      alertId: run.alertId,
      status: event.type.slice('run.'.length) as RunStatus,
      dryRun: run.dryRun,
      durationMs: Math.max(0, Date.parse(event.occurredAt) - Date.parse(startedAt)),
    },
  };
}

/** True for the four run-terminating event types. */
export function isTerminalEvent(type: RunEventRecord['type']): boolean {
  return (
    type === 'run.succeeded' ||
    type === 'run.failed' ||
    type === 'run.compensated' ||
    type === 'run.cancelled'
  );
}
