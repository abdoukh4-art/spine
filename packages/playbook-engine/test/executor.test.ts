import { describe, expect, it } from 'vitest';
import { ConcurrencyError, NonRetryableError } from '../src/errors.js';
import { advance, idempotencyKey } from '../src/executor.js';
import type { StepHandlers } from '../src/types.js';
import {
  definition,
  drive,
  InMemoryRunStore,
  recordingHandlers,
  RUN_ID,
  runStarted,
  TestClock,
  timeline,
  type Call,
} from './support.js';

const notify = (id: string, next?: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'notify' as const,
  with: { channel: '#soc', template: 'x' },
  ...(next ? { next } : {}),
  ...extra,
});
const block = (id: string, next?: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'block_indicator' as const,
  with: {},
  compensate: { type: 'unblock_indicator' as const },
  ...(next ? { next } : {}),
  ...extra,
});

function setup(def: ReturnType<typeof definition>, options: { dryRun?: boolean } = {}) {
  const store = new InMemoryRunStore();
  store.create(RUN_ID, def, [runStarted(def, options)]);
  const clock = new TestClock();
  const calls: Call[] = [];
  return { store, clock, calls };
}

describe('advance — happy paths', () => {
  it('executes a linear playbook and records a complete timeline', async () => {
    const def = definition({ start: 'a', steps: [notify('a', 'b'), notify('b')] });
    const { store, clock, calls } = setup(def);
    const result = await advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(timeline(store.events(RUN_ID))).toEqual([
      'run.started',
      'step.started:a',
      'step.succeeded:a',
      'step.started:b',
      'step.succeeded:b',
      'run.succeeded',
    ]);
    expect(calls.map((c) => c.key)).toEqual([`${RUN_ID}:a:1`, `${RUN_ID}:b:1`]);
    expect(store.events(RUN_ID)[2]?.payload.output).toEqual({ done: 'a' });
  });

  it('evaluates branches itself and records the chosen successor', async () => {
    const def = definition({
      start: 'decide',
      steps: [
        {
          id: 'decide',
          type: 'branch',
          branches: [
            { when: { field: 'alert.category', op: 'eq', value: 'phishing' }, next: 'p' },
            { when: { field: 'alert.category', op: 'eq', value: 'malware' }, next: 'm' },
          ],
          default: 'other',
        },
        notify('p'),
        notify('m'),
        notify('other'),
      ],
    });
    const { store, clock, calls } = setup(def);
    await advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) });
    expect(calls.map((c) => c.stepId)).toEqual(['m']);
    expect(store.events(RUN_ID)[2]?.payload.output).toEqual({ taken: 'm', matchedBranch: 1 });
  });

  it('takes the default branch, or ends the run when there is none', async () => {
    const steps = (withDefault: boolean) => [
      {
        id: 'decide',
        type: 'branch' as const,
        branches: [{ when: { field: 'score.score', op: 'gte' as const, value: 90 }, next: 'hot' }],
        ...(withDefault ? { default: 'cold' } : {}),
      },
      notify('hot'),
      notify('cold'),
    ];
    const withDefault = setup(definition({ start: 'decide', steps: steps(true) }));
    await advance(RUN_ID, { ...withDefault, handlers: recordingHandlers(withDefault.calls) });
    expect(withDefault.calls.map((c) => c.stepId)).toEqual(['cold']);

    const noDefault = setup(
      definition({ start: 'decide', steps: [...steps(false), notify('end')].slice(0, 2) }),
    );
    const result = await advance(RUN_ID, {
      ...noDefault,
      handlers: recordingHandlers(noDefault.calls),
    });
    expect(noDefault.calls).toEqual([]);
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
  });

  it('waits for an approval, then follows next on approve and onReject on reject', async () => {
    const def = definition({
      start: 'gate',
      steps: [
        { id: 'gate', type: 'approval', with: { prompt: 'Block?' }, next: 'yes', onReject: 'no' },
        notify('yes'),
        notify('no'),
      ],
    });
    for (const [decision, expected] of [
      ['approve', 'yes'],
      ['reject', 'no'],
    ] as const) {
      const { store, clock, calls } = setup(def);
      const first = await advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) });
      expect(first.outcome).toMatchObject({
        kind: 'waiting_approval',
        approvalId: 'approval-gate',
      });
      expect(timeline(store.events(RUN_ID)).slice(1)).toEqual([
        'step.started:gate',
        'approval.requested:gate',
      ]);
      // A stray job while waiting must not do anything.
      const again = await advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) });
      expect(again.outcome.kind).toBe('waiting_approval');
      expect(store.events(RUN_ID)).toHaveLength(3);

      await drive(store, RUN_ID, { clock, handlers: recordingHandlers(calls) }, { gate: decision });
      expect(calls.filter((c) => c.type === 'notify').map((c) => c.stepId)).toEqual([expected]);
    }
  });

  it('ends successfully when a rejected approval has no onReject', async () => {
    const def = definition({
      start: 'gate',
      steps: [{ id: 'gate', type: 'approval', with: { prompt: 'ok?' }, next: 'b' }, notify('b')],
    });
    const { store, clock, calls } = setup(def);
    const { last } = await drive(
      store,
      RUN_ID,
      { clock, handlers: recordingHandlers(calls) },
      {
        gate: 'reject',
      },
    );
    expect(last.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(calls.map((c) => c.stepId)).toEqual(['gate']);
  });

  it('dry-run passes dryRun to handlers and skips approval gates', async () => {
    const def = definition({
      start: 'gate',
      steps: [{ id: 'gate', type: 'approval', with: { prompt: 'ok?' }, next: 'b' }, block('b')],
    });
    const { store, clock, calls } = setup(def, { dryRun: true });
    const result = await advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(calls).toEqual([
      {
        stepId: 'b',
        type: 'block_indicator',
        key: `${RUN_ID}:b:1`,
        dryRun: true,
        phase: 'execute',
      },
    ]);
    expect(timeline(store.events(RUN_ID))).toContain('step.skipped:gate');
  });
});

describe('advance — failures, retries and compensation', () => {
  it('schedules a retry with backoff and re-executes with a new attempt key', async () => {
    const def = definition({
      start: 'a',
      steps: [notify('a', undefined, { retry: { maxAttempts: 3, backoffMs: 500 } })],
    });
    const { store, clock, calls } = setup(def);
    let failures = 2;
    const handlers = recordingHandlers(calls, () => {
      if (failures-- > 0) throw new Error('chat API 503');
      return { ok: true };
    });

    const first = await advance(RUN_ID, { store, clock, handlers });
    expect(first.outcome).toEqual({
      kind: 'retry_scheduled',
      notBefore: '2026-10-28T10:00:00.500Z',
      delayMs: 500,
    });
    // Too early: nothing happens, the remaining delay is reported.
    clock.advance(200);
    const early = await advance(RUN_ID, { store, clock, handlers });
    expect(early.outcome).toMatchObject({ kind: 'retry_scheduled', delayMs: 300 });

    clock.advance(300);
    const second = await advance(RUN_ID, { store, clock, handlers });
    expect(second.outcome).toMatchObject({ kind: 'retry_scheduled', delayMs: 1000 });
    clock.advance(1000);
    const third = await advance(RUN_ID, { store, clock, handlers });
    expect(third.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(calls.map((c) => c.key)).toEqual([1, 2, 3].map((n) => idempotencyKey(RUN_ID, 'a', n)));
    expect(timeline(store.events(RUN_ID))).toEqual([
      'run.started',
      'step.started:a',
      'step.failed:a',
      'step.retry_scheduled:a',
      'step.started:a',
      'step.failed:a',
      'step.retry_scheduled:a',
      'step.started:a',
      'step.succeeded:a',
      'run.succeeded',
    ]);
  });

  it('compensates completed steps in reverse order after a final failure', async () => {
    const def = definition({
      start: 'b1',
      steps: [block('b1', 'n'), notify('n', 'b2'), block('b2', 'boom'), notify('boom')],
    });
    const { store, clock, calls } = setup(def);
    const handlers = recordingHandlers(calls, (id) => {
      if (id === 'boom') throw new Error('ticketing down');
      return { blocked: id };
    });
    const result = await advance(RUN_ID, { store, clock, handlers });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'compensated' });
    const compensations = calls.filter((c) => c.phase === 'compensate');
    expect(compensations.map((c) => c.stepId)).toEqual(['b2', 'b1']);
    expect(compensations[0]?.key).toBe(`${RUN_ID}:b2:compensate`);
    expect(timeline(store.events(RUN_ID)).slice(-5)).toEqual([
      'step.failed:boom',
      'compensation.started',
      'compensation.step_succeeded:b2',
      'compensation.step_succeeded:b1',
      'run.compensated',
    ]);
  });

  it('fails the run when a compensation fails or there is nothing to compensate', async () => {
    const failing = definition({ start: 'b', steps: [block('b', 'boom'), notify('boom')] });
    const one = setup(failing);
    const handlers = recordingHandlers(
      one.calls,
      (id) => {
        if (id === 'boom') throw new Error('nope');
        return {};
      },
      () => {
        throw new Error('firewall rejected unblock');
      },
    );
    const r1 = await advance(RUN_ID, { ...one, handlers });
    expect(r1.outcome).toEqual({ kind: 'terminal', status: 'failed' });
    expect(one.store.events(RUN_ID).at(-1)?.payload).toMatchObject({
      compensated: [],
      compensationFailed: ['b'],
    });

    const nothing = setup(definition({ start: 'boom', steps: [notify('boom')] }));
    const r2 = await advance(RUN_ID, {
      ...nothing,
      handlers: recordingHandlers(nothing.calls, () => {
        throw new Error('nope');
      }),
    });
    expect(r2.outcome).toEqual({ kind: 'terminal', status: 'failed' });
    expect(timeline(nothing.store.events(RUN_ID))).not.toContain('compensation.started');
  });

  it('records a failed compensation when no compensator is registered', async () => {
    const def = definition({ start: 'b', steps: [block('b', 'boom'), notify('boom')] });
    const { store, clock, calls } = setup(def);
    const base = recordingHandlers(calls, (id) => {
      if (id === 'boom') throw new Error('x');
      return {};
    });
    const handlers: StepHandlers = {
      ...base,
      block_indicator: { execute: () => Promise.resolve({}) },
    };
    const result = await advance(RUN_ID, { store, clock, handlers });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'failed' });
    expect(
      store.events(RUN_ID).find((e) => e.type === 'compensation.step_failed')?.payload,
    ).toEqual({
      error: 'no compensation handler registered',
    });
  });

  it('continues past a failed step with onFailure: continue', async () => {
    const def = definition({
      start: 'a',
      steps: [notify('a', 'b', { onFailure: 'continue' }), notify('b')],
    });
    const { store, clock, calls } = setup(def);
    const handlers = recordingHandlers(calls, (id) => {
      if (id === 'a') throw new Error('optional step failed');
      return {};
    });
    const result = await advance(RUN_ID, { store, clock, handlers });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(calls.map((c) => c.stepId)).toEqual(['a', 'b']);
  });

  it('does not retry a NonRetryableError', async () => {
    const def = definition({
      start: 'a',
      steps: [notify('a', undefined, { retry: { maxAttempts: 5 } })],
    });
    const { store, clock, calls } = setup(def);
    const handlers = recordingHandlers(calls, () => {
      throw new NonRetryableError('invalid channel');
    });
    const result = await advance(RUN_ID, { store, clock, handlers });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'failed' });
    expect(calls).toHaveLength(1);
  });

  it('fails a step that exceeds its timeout', async () => {
    const def = definition({ start: 'a', steps: [notify('a', undefined, { timeoutMs: 100 })] });
    const { store, clock } = setup(def);
    let aborted = false;
    const handlers: StepHandlers = {
      notify: {
        execute: (_step, ctx) =>
          new Promise(() => {
            ctx.signal.addEventListener('abort', () => (aborted = true));
          }),
      },
    };
    const result = await advance(RUN_ID, { store, clock, handlers });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'failed' });
    expect(aborted).toBe(true);
    expect(store.events(RUN_ID).find((e) => e.type === 'step.failed')?.payload.error).toBe(
      'step timed out after 100 ms',
    );
  });

  it('fails steps without a handler, or with output that is not JSON', async () => {
    const def = definition({ start: 'a', steps: [notify('a')] });
    const missing = setup(def);
    expect((await advance(RUN_ID, { ...missing, handlers: {} })).outcome).toMatchObject({
      status: 'failed',
    });

    const badJson = setup(def);
    const r = await advance(RUN_ID, {
      ...badJson,
      handlers: { notify: { execute: () => Promise.resolve({ n: 1n }) } },
    });
    expect(r.outcome).toMatchObject({ status: 'failed' });
  });

  it('fails an approval step whose handler returns no approval id', async () => {
    const def = definition({
      start: 'g',
      steps: [{ id: 'g', type: 'approval', with: { prompt: 'x' } }],
    });
    const { store, clock } = setup(def);
    const result = await advance(RUN_ID, {
      store,
      clock,
      handlers: { approval: { execute: () => Promise.resolve({}) } },
    });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'failed' });
  });
});

describe('advance — durability and concurrency', () => {
  it('re-executes a started-but-unfinished step once, with the same idempotency key', async () => {
    const def = definition({ start: 'a', steps: [block('a', 'b'), notify('b')] });
    const { store, clock, calls } = setup(def);
    const key = idempotencyKey(RUN_ID, 'a', 1);
    // The previous worker appended step.started and then crashed mid-step.
    await store.append(RUN_ID, 1, [
      {
        seq: 2,
        type: 'step.started',
        stepId: 'a',
        payload: { attempt: 1, idempotencyKey: key },
        occurredAt: clock.now().toISOString(),
      },
    ]);
    const result = await advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(calls.filter((c) => c.stepId === 'a').map((c) => c.key)).toEqual([key]);
    expect(timeline(store.events(RUN_ID)).filter((t) => t === 'step.started:a')).toHaveLength(1);
  });

  it('reloads and carries on when another writer appends first', async () => {
    const def = definition({ start: 'a', steps: [notify('a', 'b'), notify('b')] });
    const { store, clock, calls } = setup(def);
    let raced = false;
    store.beforeAppend = (runId, expectedSeq) => {
      if (raced || expectedSeq !== 2) return;
      raced = true;
      // A competing worker finishes step a first.
      store.logs.get(runId)?.push({
        seq: 3,
        type: 'step.succeeded',
        stepId: 'a',
        payload: { attempt: 1, output: { by: 'other' } },
        occurredAt: clock.now().toISOString(),
      });
    };
    const result = await advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) });
    expect(result.conflicts).toBe(1);
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(
      store.events(RUN_ID).filter((e) => e.type === 'step.succeeded' && e.stepId === 'a'),
    ).toHaveLength(1);
  });

  it('propagates unexpected store errors', async () => {
    const def = definition({ start: 'a', steps: [notify('a')] });
    const { store, clock, calls } = setup(def);
    store.beforeAppend = () => {
      throw new Error('database is down');
    };
    await expect(
      advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) }),
    ).rejects.toThrow('database is down');
  });

  it('stops at a cancelled run without calling handlers', async () => {
    const def = definition({ start: 'a', steps: [notify('a')] });
    const { store, clock, calls } = setup(def);
    await store.append(RUN_ID, 1, [
      {
        seq: 2,
        type: 'run.cancelled',
        stepId: null,
        payload: {},
        occurredAt: clock.now().toISOString(),
      },
    ]);
    const result = await advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'cancelled' });
    expect(calls).toEqual([]);
  });

  it('yields without recording anything when the host aborts mid-step', async () => {
    const def = definition({ start: 'a', steps: [notify('a')] });
    const { store, clock, calls } = setup(def);
    const host = new AbortController();
    const handlers: StepHandlers = {
      notify: {
        execute: (_s, ctx) => {
          calls.push({
            stepId: 'a',
            type: 'notify',
            key: ctx.idempotencyKey,
            dryRun: false,
            phase: 'execute',
          });
          host.abort();
          return new Promise(() => undefined);
        },
      },
    };
    const result = await advance(RUN_ID, { store, clock, handlers, signal: host.signal });
    expect(result.outcome).toEqual({ kind: 'yielded', reason: 'aborted' });
    expect(timeline(store.events(RUN_ID))).toEqual(['run.started', 'step.started:a']);
    const resumed = await advance(RUN_ID, { store, clock, handlers: recordingHandlers(calls) });
    expect(resumed.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set([`${RUN_ID}:a:1`]));
  });

  it('yields when an already-aborted host signal is passed, and during compensation', async () => {
    const def = definition({ start: 'b', steps: [block('b', 'boom'), notify('boom')] });
    const { store, clock, calls } = setup(def);
    const host = new AbortController();
    const handlers = recordingHandlers(calls, (id) => {
      if (id === 'boom') {
        host.abort();
        throw new Error('fail');
      }
      return {};
    });
    const result = await advance(RUN_ID, { store, clock, handlers, signal: host.signal });
    expect(result.outcome).toEqual({ kind: 'yielded', reason: 'aborted' });
  });

  it('yields after maxIterations so one long run cannot monopolize a worker', async () => {
    const def = definition({
      start: 'a',
      steps: [notify('a', 'b'), notify('b', 'c'), notify('c')],
    });
    const { store, clock, calls } = setup(def);
    const result = await advance(RUN_ID, {
      store,
      clock,
      handlers: recordingHandlers(calls),
      maxIterations: 2,
    });
    expect(result.outcome).toEqual({ kind: 'yielded', reason: 'max_iterations' });
    expect(result.iterations).toBe(2);
  });

  it('reports unknown runs as not_found', async () => {
    const store = new InMemoryRunStore();
    const result = await advance('nope', { store, clock: new TestClock(), handlers: {} });
    expect(result.outcome).toEqual({ kind: 'not_found' });
  });

  it('notifies hooks and ignores hook failures', async () => {
    const def = definition({ start: 'a', steps: [notify('a')] });
    const { store, clock, calls } = setup(def);
    const seen: string[] = [];
    const result = await advance(RUN_ID, {
      store,
      clock,
      handlers: recordingHandlers(calls),
      hooks: {
        onStepFinished: (info) => {
          seen.push(`${info.type}:${info.status}`);
          throw new Error('metrics exporter broke');
        },
      },
    });
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(seen).toEqual(['notify:succeeded']);
  });

  it('exposes ConcurrencyError details', () => {
    const err = new ConcurrencyError('r', 4);
    expect(err.message).toContain('expected last seq 4');
  });
});
