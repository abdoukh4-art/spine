import { TERMINAL_RUN_STATUSES, type PlaybookDefinition, type Step } from '@spine/shared-schema';
import { RunStateError } from './errors.js';
import type { NextAction, RunState } from './types.js';

/**
 * The decider: given the definition and the current (reduced) state, what should happen
 * next? It is pure, so "what would the engine do now?" can be asked about any event
 * log, including one truncated by a crash.
 */

/** Inputs to {@link decide} that are not in the event log. */
export interface DecideContext {
  now: Date;
}

/** Upper bound for an exponential retry delay. */
export const MAX_RETRY_DELAY_MS = 600_000;

/** True for statuses a run never leaves. */
export function isTerminal(status: RunState['status']): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Decides the next action for a run.
 * @throws RunStateError when the state is inconsistent with the definition.
 */
export function decide(
  definition: PlaybookDefinition,
  state: RunState,
  context: DecideContext,
): NextAction {
  if (isTerminal(state.status)) return { kind: 'Halt', status: state.status };
  if (state.inputs === null) throw new RunStateError('run has no run.started event');
  if (state.failure !== null || state.compensation.started) {
    return decideRecovery(definition, state);
  }
  if (state.pendingApproval !== null) {
    const { stepId, approvalId, expiresAt } = state.pendingApproval;
    return { kind: 'WaitForApproval', stepId, approvalId, expiresAt };
  }
  const stepId = state.currentStepId;
  if (stepId === null) return { kind: 'Finish', status: 'succeeded' };
  const step = definition.steps.find((s) => s.id === stepId);
  if (!step) throw new RunStateError(`current step ${stepId} is not in the definition`);
  return decideStep(step, state, context);
}

function decideStep(step: Step, state: RunState, context: DecideContext): NextAction {
  const s = state.steps[step.id];
  if (!s) throw new RunStateError(`no state for step ${step.id}`);
  switch (s.status) {
    case 'pending':
      if (step.type !== 'approval') {
        return { kind: 'ExecuteStep', stepId: step.id, attempt: 1, resume: false };
      }
      return state.inputs?.dryRun === true
        ? { kind: 'SkipStep', stepId: step.id, reason: 'dry run: approval assumed granted' }
        : { kind: 'RequestApproval', stepId: step.id };
    case 'running':
      // Started but never finished: the worker crashed (or another one is on it). Re-run
      // the SAME attempt, so the handler sees the same idempotency key (ADR-0018).
      if (step.type === 'approval') return { kind: 'RequestApproval', stepId: step.id };
      return { kind: 'ExecuteStep', stepId: step.id, attempt: s.attempts, resume: true };
    case 'failed':
      return {
        kind: 'ScheduleRetry',
        stepId: step.id,
        attempt: s.attempts + 1,
        delayMs: retryDelayMs(step, s.attempts),
      };
    case 'waiting':
      if (s.retry === null) throw new RunStateError(`step ${step.id} waits for nothing`);
      if (context.now.getTime() < Date.parse(s.retry.notBefore)) {
        return {
          kind: 'WaitForRetry',
          stepId: step.id,
          attempt: s.retry.attempt,
          notBefore: s.retry.notBefore,
        };
      }
      return { kind: 'ExecuteStep', stepId: step.id, attempt: s.retry.attempt, resume: false };
    default:
      throw new RunStateError(`current step ${step.id} is already ${s.status}`);
  }
}

/**
 * Backward recovery (saga): compensate completed steps that declare `compensate`, in the
 * exact reverse order of their completion, then finish as `compensated` (all undone) or
 * `failed` (nothing to undo, or an undo failed and needs a human).
 */
function decideRecovery(definition: PlaybookDefinition, state: RunState): NextAction {
  const compensable = [...state.completedSteps]
    .reverse()
    .filter((id) => definition.steps.some((s) => s.id === id && hasCompensation(s)));
  if (compensable.length === 0) return { kind: 'Finish', status: 'failed' };
  const done = new Set([...state.compensation.succeeded, ...state.compensation.failed]);
  const next = compensable.find((id) => !done.has(id));
  if (next !== undefined) return { kind: 'Compensate', stepId: next };
  return {
    kind: 'Finish',
    status: state.compensation.failed.length > 0 ? 'failed' : 'compensated',
  };
}

/** True if the step declares a compensating action. */
export function hasCompensation(step: Step): boolean {
  return 'compensate' in step && step.compensate !== undefined;
}

/**
 * Exponential backoff: `backoffMs × 2^(failedAttempt − 1)`, capped. Deterministic on
 * purpose (no jitter) so replays and tests are exact; jitter belongs to the queue.
 */
export function retryDelayMs(step: Step, failedAttempt: number): number {
  const base = step.retry?.backoffMs ?? 1000;
  return Math.min(MAX_RETRY_DELAY_MS, base * 2 ** Math.max(0, failedAttempt - 1));
}
