import { evaluateCondition, type PlaybookDefinition, type Step } from '@spine/shared-schema';
import { buildEvaluationContext, isRecord } from './context.js';
import { decide } from './decide.js';
import { ConcurrencyError, NonRetryableError } from './errors.js';
import { reduce } from './reduce.js';
import type {
  AdvanceOutcome,
  AdvanceResult,
  ExecutorPorts,
  NextAction,
  RunEventRecord,
  RunState,
  StepContext,
} from './types.js';

/**
 * The executor: the only part of the engine that touches the outside world, and only
 * through ports. One call to {@link advance} runs the loop
 *
 *   load events → reduce → decide → act (call a handler) → append events → repeat
 *
 * until the run is terminal or must wait (for a human, or for a retry delay). Because every
 * decision is re-derived from the stored events, the process can die at ANY point and a
 * later `advance` continues correctly. That is what "durable execution" means.
 */

/** Default guard against runaway loops in one call. */
export const DEFAULT_MAX_ITERATIONS = 200;
/** Longest error message stored in an event. */
const MAX_ERROR_LENGTH = 1000;

type Pending = Omit<RunEventRecord, 'seq' | 'occurredAt'>;
type Stop = { kind: 'stop'; outcome: AdvanceOutcome };

/** Builds the idempotency key of one attempt of one step: `${runId}:${stepId}:${attempt}`. */
export function idempotencyKey(
  runId: string,
  stepId: string,
  attempt: number | 'compensate',
): string {
  return `${runId}:${stepId}:${String(attempt)}`;
}

/** Thrown inside a handler's race when the per-step timeout elapses. */
export class StepTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`step timed out after ${timeoutMs} ms`);
    this.name = 'StepTimeoutError';
  }
}

/** Thrown when the host aborted the work (e.g. worker shutdown); nothing is recorded. */
class HostAbortError extends Error {}

/**
 * Appends events with consecutive sequence numbers, starting after the state it was
 * created from, and remembers what it appended so the loop needn't reload.
 */
class Appender {
  readonly appended: RunEventRecord[] = [];
  private seq: number;

  constructor(
    private readonly runId: string,
    private readonly ports: ExecutorPorts,
    lastSeq: number,
  ) {
    this.seq = lastSeq;
  }

  async append(pending: readonly Pending[]): Promise<void> {
    if (pending.length === 0) return;
    const occurredAt = this.ports.clock.now().toISOString();
    const records = pending.map((e, i) => ({ ...e, seq: this.seq + 1 + i, occurredAt }));
    await this.ports.store.append(this.runId, this.seq, records);
    this.seq += records.length;
    this.appended.push(...records);
  }
}

/**
 * Advances a run as far as it can go right now.
 * Optimistic-concurrency conflicts are resolved by reloading and deciding again.
 */
export async function advance(runId: string, ports: ExecutorPorts): Promise<AdvanceResult> {
  const maxIterations = ports.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let loaded = await ports.store.load(runId);
  if (!loaded) return { outcome: { kind: 'not_found' }, iterations: 0, conflicts: 0, lastSeq: 0 };
  const { definition } = loaded;
  let events = loaded.events;
  let iterations = 0;
  let conflicts = 0;

  while (iterations < maxIterations) {
    iterations += 1;
    const state = reduce(definition, events);
    const action = decide(definition, state, { now: ports.clock.now() });
    const appender = new Appender(runId, ports, state.lastSeq);
    let stop: Stop | undefined;
    try {
      stop = await act(runId, definition, state, action, ports, appender);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
      conflicts += 1;
      loaded = await ports.store.load(runId);
      if (!loaded) return { outcome: { kind: 'not_found' }, iterations, conflicts, lastSeq: 0 };
      events = loaded.events;
      continue;
    }
    events = [...events, ...appender.appended];
    if (stop) return { outcome: stop.outcome, iterations, conflicts, lastSeq: lastSeqOf(events) };
  }
  return {
    outcome: { kind: 'yielded', reason: 'max_iterations' },
    iterations,
    conflicts,
    lastSeq: lastSeqOf(events),
  };
}

function lastSeqOf(events: readonly RunEventRecord[]): number {
  return events.at(-1)?.seq ?? 0;
}

/** Performs one decided action. Returns a Stop when `advance` should return. */
async function act(
  runId: string,
  definition: PlaybookDefinition,
  state: RunState,
  action: NextAction,
  ports: ExecutorPorts,
  out: Appender,
): Promise<Stop | undefined> {
  const stepOf = (id: string): Step => {
    const step = definition.steps.find((s) => s.id === id);
    if (!step) throw new Error(`unknown step ${id}`);
    return step;
  };
  switch (action.kind) {
    case 'Halt':
      return stop({ kind: 'terminal', status: action.status });
    case 'WaitForApproval':
      return stop({
        kind: 'waiting_approval',
        approvalId: action.approvalId,
        expiresAt: action.expiresAt,
      });
    case 'WaitForRetry': {
      const delayMs = Math.max(0, Date.parse(action.notBefore) - ports.clock.now().getTime());
      return stop({ kind: 'retry_scheduled', notBefore: action.notBefore, delayMs });
    }
    case 'ScheduleRetry': {
      const notBefore = new Date(ports.clock.now().getTime() + action.delayMs).toISOString();
      const payload = { attempt: action.attempt, delayMs: action.delayMs, notBefore };
      await out.append([{ type: 'step.retry_scheduled', stepId: action.stepId, payload }]);
      return stop({ kind: 'retry_scheduled', notBefore, delayMs: action.delayMs });
    }
    case 'SkipStep':
      await out.append([
        { type: 'step.skipped', stepId: action.stepId, payload: { reason: action.reason } },
      ]);
      return undefined;
    case 'Finish':
      await out.append([{ type: `run.${action.status}`, stepId: null, payload: finish(state) }]);
      return undefined;
    case 'Compensate':
      return compensate(runId, stepOf(action.stepId), state, ports, out);
    case 'RequestApproval': {
      const s = state.steps[action.stepId];
      const resume = s?.status === 'running';
      const attempt = resume ? s.attempts : 1;
      return executeStep(runId, stepOf(action.stepId), attempt, resume, state, ports, out);
    }
    case 'ExecuteStep': {
      const step = stepOf(action.stepId);
      return executeStep(runId, step, action.attempt, action.resume, state, ports, out);
    }
  }
}

function stop(outcome: AdvanceOutcome): Stop {
  return { kind: 'stop', outcome };
}

function finish(state: RunState): Record<string, unknown> {
  return {
    ...(state.failure ? { failure: state.failure } : {}),
    ...(state.compensation.started
      ? {
          compensated: state.compensation.succeeded,
          compensationFailed: state.compensation.failed,
        }
      : {}),
  };
}

async function executeStep(
  runId: string,
  step: Step,
  attempt: number,
  resume: boolean,
  state: RunState,
  ports: ExecutorPorts,
  out: Appender,
): Promise<Stop | undefined> {
  const key = idempotencyKey(runId, step.id, attempt);
  const started: Pending[] = resume
    ? []
    : [{ type: 'step.started', stepId: step.id, payload: { attempt, idempotencyKey: key } }];
  const input = buildEvaluationContext(runId, state);

  if (step.type === 'branch') {
    // Branches are pure decisions: evaluated here and recorded in the same append as
    // step.started, so the chosen path is a stored fact and replays never re-evaluate it.
    const output = evaluateBranch(step, input);
    const result: Pending = {
      type: 'step.succeeded',
      stepId: step.id,
      payload: { attempt, output },
    };
    await out.append([...started, result]);
    return undefined;
  }

  // Record the attempt BEFORE the side effect: if we crash after this append, the resumed
  // run sees "started, not finished" and re-runs the same attempt with the same key.
  // (Approval requests are idempotent and recorded together with their result instead.)
  const startNow = step.type !== 'approval';
  if (startNow) await out.append(started);

  const begin = ports.clock.now().getTime();
  const ctx = {
    runId,
    alert: state.inputs?.alert ?? null,
    dryRun: state.inputs?.dryRun ?? false,
    idempotencyKey: key,
    attempt,
    input,
  };
  const outcome = await runHandler(step, ctx, ports);
  if (outcome.kind === 'aborted') return stop({ kind: 'yielded', reason: 'aborted' });
  const durationMs = Math.max(0, ports.clock.now().getTime() - begin);
  const status = outcome.kind === 'ok' ? 'succeeded' : 'failed';
  notifyStepFinished(ports, { runId, step, status, durationMs, attempt });
  await out.append([
    ...(startNow ? [] : started),
    ...resultEvents(step, attempt, outcome, durationMs),
  ]);
  return undefined;
}

type HandlerOutcome =
  | { kind: 'ok'; output: unknown }
  | { kind: 'error'; error: string; retryable: boolean }
  | { kind: 'aborted' };

function resultEvents(
  step: Step,
  attempt: number,
  outcome: Exclude<HandlerOutcome, { kind: 'aborted' }>,
  durationMs: number,
): Pending[] {
  if (outcome.kind === 'error') {
    const payload = { attempt, error: outcome.error, retryable: outcome.retryable, durationMs };
    return [{ type: 'step.failed', stepId: step.id, payload }];
  }
  if (step.type === 'approval') {
    const output = isRecord(outcome.output) ? outcome.output : {};
    return [{ type: 'approval.requested', stepId: step.id, payload: { ...output, attempt } }];
  }
  const payload = { attempt, output: outcome.output, durationMs };
  return [{ type: 'step.succeeded', stepId: step.id, payload }];
}

async function runHandler(
  step: Step,
  ctx: Omit<StepContext, 'signal'>,
  ports: ExecutorPorts,
): Promise<HandlerOutcome> {
  const handler = step.type === 'branch' ? undefined : ports.handlers[step.type];
  if (!handler) {
    const error = `no handler registered for step type "${step.type}"`;
    return { kind: 'error', error, retryable: false };
  }
  try {
    const raw = await withTimeout(step.timeoutMs, ports.signal, (signal) =>
      handler.execute(step, { ...ctx, signal }),
    );
    const output = toJson(raw);
    if (step.type === 'approval' && !isApprovalOutput(output)) {
      const error = 'approval handler returned no approvalId/expiresAt';
      return { kind: 'error', error, retryable: false };
    }
    return { kind: 'ok', output };
  } catch (err) {
    if (err instanceof HostAbortError) return { kind: 'aborted' };
    const retryable = !(err instanceof NonRetryableError);
    return { kind: 'error', error: errorMessage(err), retryable };
  }
}

async function compensate(
  runId: string,
  step: Step,
  state: RunState,
  ports: ExecutorPorts,
  out: Appender,
): Promise<Stop | undefined> {
  const prefix: Pending[] = state.compensation.started
    ? []
    : [{ type: 'compensation.started', stepId: null, payload: { failure: state.failure } }];
  const handler = step.type === 'branch' ? undefined : ports.handlers[step.type];
  const failed = (error: string): Pending => ({
    type: 'compensation.step_failed',
    stepId: step.id,
    payload: { error },
  });
  if (!handler?.compensate) {
    await out.append([...prefix, failed('no compensation handler registered')]);
    return undefined;
  }
  const compensator = handler.compensate.bind(handler);
  const ctx = {
    runId,
    alert: state.inputs?.alert ?? null,
    dryRun: state.inputs?.dryRun ?? false,
    idempotencyKey: idempotencyKey(runId, step.id, 'compensate'),
    attempt: 1,
    input: buildEvaluationContext(runId, state),
  };
  const original = state.steps[step.id]?.output;
  let result: Pending;
  try {
    const raw = await withTimeout(step.timeoutMs, ports.signal, (signal) =>
      compensator(step, { ...ctx, signal }, original),
    );
    const payload = { output: toJson(raw) };
    result = { type: 'compensation.step_succeeded', stepId: step.id, payload };
  } catch (err) {
    if (err instanceof HostAbortError) return stop({ kind: 'yielded', reason: 'aborted' });
    result = failed(errorMessage(err));
  }
  await out.append([...prefix, result]);
  return undefined;
}

/** Evaluates a branch: the first matching branch wins, else `default`, else the path ends. */
export function evaluateBranch(
  step: Extract<Step, { type: 'branch' }>,
  context: unknown,
): { taken: string | null; matchedBranch: number | null } {
  for (const [index, branch] of step.branches.entries()) {
    if (evaluateCondition(branch.when, context)) {
      return { taken: branch.next, matchedBranch: index };
    }
  }
  return { taken: step.default ?? null, matchedBranch: null };
}

/**
 * Runs `fn` with an AbortSignal that fires when `timeoutMs` elapses or the host aborts.
 * The race guarantees we stop waiting even if the handler ignores its signal.
 */
async function withTimeout<T>(
  timeoutMs: number,
  host: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (host?.aborted) throw new HostAbortError('aborted by host');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onHostAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new StepTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    onHostAbort = () => {
      const error = new HostAbortError('aborted by host');
      controller.abort(error);
      reject(error);
    };
    host?.addEventListener('abort', onHostAbort, { once: true });
  });
  try {
    return await Promise.race([fn(controller.signal), guard]);
  } finally {
    clearTimeout(timer);
    if (onHostAbort) host?.removeEventListener('abort', onHostAbort);
  }
}

function notifyStepFinished(
  ports: ExecutorPorts,
  info: {
    runId: string;
    step: Step;
    status: 'succeeded' | 'failed';
    durationMs: number;
    attempt: number;
  },
): void {
  try {
    ports.hooks?.onStepFinished?.({
      runId: info.runId,
      stepId: info.step.id,
      type: info.step.type,
      status: info.status,
      durationMs: info.durationMs,
      attempt: info.attempt,
    });
  } catch {
    // Observability must never break execution.
  }
}

function isApprovalOutput(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.approvalId === 'string' && typeof value.expiresAt === 'string'
  );
}

/** Outputs are stored as JSON; normalizing here makes in-memory and stored runs identical. */
function toJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}
