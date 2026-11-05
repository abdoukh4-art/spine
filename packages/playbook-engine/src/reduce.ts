import type { PlaybookDefinition, Step } from '@spine/shared-schema';
import { isRecord } from './context.js';
import { RunStateError } from './errors.js';
import type { RunEventRecord, RunStartedPayload, RunState, StepRunState } from './types.js';

/**
 * The run reducer (ADR-0010): `state = events.reduce(apply, initial)`.
 *
 * It is a pure function of the definition and the events, which gives us three things:
 * crash recovery is "load the events and reduce", the console timeline is the event list
 * itself, and the whole thing can be property-tested without a database.
 *
 * Rule for evolving it: never change what an existing event type means. New behaviour
 * needs a new event type, a new case here, and a test.
 */

/** The state of a run with no events yet. */
export function initialRunState(definition: PlaybookDefinition): RunState {
  const steps: Record<string, StepRunState> = {};
  for (const step of definition.steps) {
    steps[step.id] = {
      stepId: step.id,
      type: step.type,
      status: 'pending',
      attempts: 0,
      idempotencyKey: null,
      finalFailure: false,
      retry: null,
      next: undefined,
      startedAt: null,
      finishedAt: null,
    };
  }
  return {
    status: 'pending',
    inputs: null,
    steps,
    currentStepId: null,
    completedSteps: [],
    pendingApproval: null,
    failure: null,
    compensation: { started: false, succeeded: [], failed: [] },
    lastSeq: 0,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    approvalWaitMs: 0,
  };
}

/** Folds the whole event log into a {@link RunState}. Deterministic and side-effect free. */
export function reduce(
  definition: PlaybookDefinition,
  events: readonly RunEventRecord[],
): RunState {
  const state = initialRunState(definition);
  const stepsById = indexSteps(definition);
  for (const event of events) mutate(definition, stepsById, state, event);
  return state;
}

/** Applies one event to a state, returning a new state (the input is not modified). */
export function applyEvent(
  definition: PlaybookDefinition,
  state: RunState,
  event: RunEventRecord,
): RunState {
  const next = structuredClone(state);
  mutate(definition, indexSteps(definition), next, event);
  return next;
}

/** Maximum attempts allowed by a step's retry policy (1 when it has none). */
export function maxAttempts(step: Step): number {
  return step.retry?.maxAttempts ?? 1;
}

function indexSteps(definition: PlaybookDefinition): Map<string, Step> {
  return new Map(definition.steps.map((s) => [s.id, s]));
}

function mutate(
  definition: PlaybookDefinition,
  stepsById: ReadonlyMap<string, Step>,
  state: RunState,
  event: RunEventRecord,
): void {
  if (event.seq !== state.lastSeq + 1) {
    throw new RunStateError(`event seq ${event.seq} does not follow ${state.lastSeq}`);
  }
  state.lastSeq = event.seq;
  if (event.type === 'run.started') {
    state.inputs = event.payload as unknown as RunStartedPayload;
    state.createdAt = event.occurredAt;
    state.currentStepId = definition.start;
    return;
  }
  if (state.inputs === null) throw new RunStateError(`${event.type} before run.started`);
  if (applyRunEvent(state, event)) return;

  const step = event.stepId === null ? undefined : stepsById.get(event.stepId);
  const stepState = event.stepId === null ? undefined : state.steps[event.stepId];
  if (!step || !stepState) {
    throw new RunStateError(`${event.type} refers to unknown step ${String(event.stepId)}`);
  }
  applyStepEvent(state, step, stepState, event);
}

/** Run-level events. Returns true when the event was handled. */
function applyRunEvent(state: RunState, event: RunEventRecord): boolean {
  switch (event.type) {
    case 'run.succeeded':
    case 'run.failed':
    case 'run.compensated':
    case 'run.cancelled':
      state.status = event.type.slice('run.'.length) as RunState['status'];
      state.finishedAt = event.occurredAt;
      state.pendingApproval = null;
      return true;
    case 'compensation.started':
      state.status = 'compensating';
      state.compensation.started = true;
      return true;
    default:
      return false;
  }
}

function applyStepEvent(state: RunState, step: Step, s: StepRunState, event: RunEventRecord): void {
  const p = event.payload;
  switch (event.type) {
    case 'step.started':
      s.status = 'running';
      s.attempts = num(p.attempt, s.attempts + 1);
      s.idempotencyKey = typeof p.idempotencyKey === 'string' ? p.idempotencyKey : null;
      s.retry = null;
      s.startedAt ??= event.occurredAt;
      state.startedAt ??= event.occurredAt;
      if (state.status !== 'compensating') state.status = 'running';
      return;
    case 'step.succeeded':
      finish(state, s, event, 'succeeded', successorOf(step, p.output));
      s.output = p.output;
      delete s.error;
      return;
    case 'step.failed':
      applyFailure(state, step, s, event);
      return;
    case 'step.retry_scheduled':
      s.status = 'waiting';
      s.retry = { attempt: num(p.attempt, s.attempts + 1), notBefore: String(p.notBefore) };
      return;
    case 'step.skipped':
      s.status = 'skipped';
      s.finishedAt = event.occurredAt;
      s.next = successorOf(step, undefined);
      state.currentStepId = s.next;
      if (state.status === 'pending') state.status = 'running';
      return;
    default:
      applyApprovalOrCompensation(state, step, s, event);
  }
}

function applyApprovalOrCompensation(
  state: RunState,
  step: Step,
  s: StepRunState,
  event: RunEventRecord,
): void {
  const p = event.payload;
  switch (event.type) {
    case 'approval.requested':
      s.status = 'waiting';
      state.status = 'waiting_approval';
      state.pendingApproval = {
        stepId: step.id,
        approvalId: String(p.approvalId),
        expiresAt: String(p.expiresAt),
        requestedAt: event.occurredAt,
      };
      return;
    case 'approval.granted':
    case 'approval.rejected': {
      const approved = event.type === 'approval.granted';
      const requestedAt = state.pendingApproval?.requestedAt;
      if (requestedAt !== undefined) {
        state.approvalWaitMs += Math.max(0, Date.parse(event.occurredAt) - Date.parse(requestedAt));
      }
      state.pendingApproval = null;
      state.status = 'running';
      s.output = { ...p, decision: approved ? 'approved' : 'rejected' };
      const successor =
        step.type === 'approval' ? (approved ? step.next : step.onReject) : undefined;
      finish(state, s, event, 'succeeded', successor ?? null);
      return;
    }
    case 'compensation.step_succeeded':
      state.compensation.succeeded.push(step.id);
      s.status = 'compensated';
      return;
    case 'compensation.step_failed':
      state.compensation.failed.push(step.id);
      return;
    default:
      throw new RunStateError(`unexpected event type ${event.type}`);
  }
}

function applyFailure(state: RunState, step: Step, s: StepRunState, event: RunEventRecord): void {
  const p = event.payload;
  const attempt = num(p.attempt, s.attempts);
  s.status = 'failed';
  s.error = typeof p.error === 'string' ? p.error : 'unknown error';
  s.finishedAt = event.occurredAt;
  s.finalFailure = p.retryable === false || attempt >= maxAttempts(step);
  if (!s.finalFailure) return;
  if (step.onFailure === 'continue') {
    s.next = successorOf(step, undefined);
    state.currentStepId = s.next;
  } else {
    state.failure = { stepId: step.id, error: s.error };
  }
}

function finish(
  state: RunState,
  s: StepRunState,
  event: RunEventRecord,
  status: 'succeeded',
  successor: string | null,
): void {
  s.status = status;
  s.finishedAt = event.occurredAt;
  s.next = successor;
  s.retry = null;
  state.completedSteps.push(s.stepId);
  state.currentStepId = successor;
}

/**
 * The successor of a finished step. For a branch, it is the target recorded in the
 * step's output when it was evaluated (`{ taken }`), never re-evaluated on replay.
 */
function successorOf(step: Step, output: unknown): string | null {
  if (step.type === 'branch') {
    if (isRecord(output) && typeof output.taken === 'string') return output.taken;
    return isRecord(output) && 'taken' in output ? null : (step.default ?? null);
  }
  return step.next ?? null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
