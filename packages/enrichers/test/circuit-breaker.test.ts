import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  CircuitBreaker,
  CircuitOpenError,
  VirtualScheduler,
  type CircuitBreakerOptions,
  type CircuitState,
} from '../src/index.js';

const ok = (): Promise<string> => Promise.resolve('ok');
const fail = (): Promise<never> => Promise.reject(new Error('down'));

function breaker(overrides: Partial<CircuitBreakerOptions> = {}) {
  const scheduler = new VirtualScheduler(1_000_000);
  const changes: { from: CircuitState; to: CircuitState }[] = [];
  const cb = new CircuitBreaker({
    failureRateThreshold: 0.5,
    windowSize: 4,
    minimumCalls: 4,
    cooldownMs: 1000,
    halfOpenMaxCalls: 1,
    scheduler,
    onStateChange: ({ from, to }) => changes.push({ from, to }),
    ...overrides,
  });
  return { cb, scheduler, changes };
}

async function drive(cb: CircuitBreaker, outcomes: boolean[]): Promise<void> {
  for (const success of outcomes) await cb.execute(success ? ok : fail).catch(() => undefined);
}

describe('CircuitBreaker', () => {
  it('stays closed below the minimum number of calls, even if they all fail', async () => {
    const { cb } = breaker();
    await drive(cb, [false, false, false]);
    expect(cb.state).toBe('closed');
    expect(cb.failureRate).toBe(1);
  });

  it('opens when the failure rate over the window reaches the threshold', async () => {
    const { cb, changes } = breaker();
    await drive(cb, [true, false, true, false]);
    expect(cb.state).toBe('open');
    expect(changes).toEqual([{ from: 'closed', to: 'open' }]);
  });

  it('only counts the last N calls (rolling window)', async () => {
    const { cb } = breaker({ failureRateThreshold: 0.75 });
    await drive(cb, [false, false, true, true, true, true]); // window = last 4: 0 failures
    expect(cb.state).toBe('closed');
    expect(cb.failureRate).toBe(0);
  });

  it('fails fast while open, without calling the provider', async () => {
    const { cb, scheduler } = breaker();
    await drive(cb, [false, false, false, false]);
    let called = false;
    await scheduler.advance(400);
    const error = await cb
      .execute(() => {
        called = true;
        return ok();
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect((error as CircuitOpenError).retryAfterMs).toBe(600);
    expect(called).toBe(false);
  });

  it('goes half-open after the cooldown and closes after a successful probe', async () => {
    const { cb, scheduler, changes } = breaker();
    await drive(cb, [false, false, false, false]);
    await scheduler.advance(1000);
    expect(cb.state).toBe('half_open');
    await expect(cb.execute(ok)).resolves.toBe('ok');
    expect(cb.state).toBe('closed');
    expect(changes.map((c) => c.to)).toEqual(['open', 'half_open', 'closed']);
  });

  it('re-opens on a failed probe and restarts the cooldown', async () => {
    const { cb, scheduler } = breaker();
    await drive(cb, [false, false, false, false]);
    await scheduler.advance(1000);
    await cb.execute(fail).catch(() => undefined);
    expect(cb.state).toBe('open');
    await scheduler.advance(999);
    expect(cb.state).toBe('open');
    await scheduler.advance(1);
    expect(cb.state).toBe('half_open');
  });

  it('limits concurrent probes in half-open and needs all of them to succeed', async () => {
    const { cb, scheduler } = breaker({ halfOpenMaxCalls: 2 });
    await drive(cb, [false, false, false, false]);
    await scheduler.advance(1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p1 = cb.execute(() => gate.then(() => 'p1'));
    const p2 = cb.execute(() => gate.then(() => 'p2'));
    await expect(cb.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await expect(Promise.all([p1, p2])).resolves.toEqual(['p1', 'p2']);
    expect(cb.state).toBe('closed');
  });

  it('ignores a straggler that started in an earlier state', async () => {
    const { cb, scheduler } = breaker({ windowSize: 2, minimumCalls: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const straggler = cb.execute(() => gate.then(() => 'late'));
    await drive(cb, [false, false]); // opens
    expect(cb.state).toBe('open');
    await scheduler.advance(1000);
    expect(cb.state).toBe('half_open');
    release();
    await straggler; // a success from the closed generation must not close the circuit
    expect(cb.state).toBe('half_open');
  });

  it('does not count caller aborts as provider failures, and frees the probe slot', async () => {
    const { cb, scheduler } = breaker();
    for (let i = 0; i < 10; i += 1) {
      await cb.execute(() => Promise.reject(new AbortedError())).catch(() => undefined);
    }
    expect(cb.state).toBe('closed');
    await drive(cb, [false, false, false, false]);
    await scheduler.advance(1000);
    await cb.execute(() => Promise.reject(new AbortedError())).catch(() => undefined);
    expect(cb.state).toBe('half_open');
    await expect(cb.execute(ok)).resolves.toBe('ok'); // slot was released
  });

  it('rejects inconsistent options', () => {
    expect(() => breaker({ failureRateThreshold: 0 })).toThrow(RangeError);
    expect(() => breaker({ minimumCalls: 5 })).toThrow(/minimumCalls/);
    expect(() => breaker({ windowSize: 0 })).toThrow(/windowSize/);
    expect(() => breaker({ cooldownMs: -1 })).toThrow(/cooldownMs/);
    expect(() => breaker({ halfOpenMaxCalls: 0 })).toThrow(/halfOpenMaxCalls/);
  });

  it('works with the default (real) scheduler', async () => {
    const cb = new CircuitBreaker({
      failureRateThreshold: 1,
      windowSize: 1,
      minimumCalls: 1,
      cooldownMs: 60_000,
      halfOpenMaxCalls: 1,
    });
    await expect(cb.execute(ok)).resolves.toBe('ok');
    await cb.execute(fail).catch(() => undefined);
    expect(cb.state).toBe('open');
  });

  type Op = { kind: 'call'; success: boolean } | { kind: 'wait'; ms: number };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant('call' as const), success: fc.boolean() }),
    fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 1500 }) }),
  );

  it('property: never lets a call through while open before the cooldown; legal transitions only', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { maxLength: 80 }),
        fc.integer({ min: 1, max: 6 }),
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 3 }),
        async (ops, windowSize, threshold, halfOpenMaxCalls) => {
          const scheduler = new VirtualScheduler();
          const transitions: { from: CircuitState; to: CircuitState; at: number }[] = [];
          const cb = new CircuitBreaker({
            failureRateThreshold: threshold,
            windowSize,
            minimumCalls: Math.max(1, Math.ceil(windowSize / 2)),
            cooldownMs: 1000,
            halfOpenMaxCalls,
            scheduler,
            onStateChange: (c) => transitions.push(c),
          });
          for (const op of ops) {
            if (op.kind === 'wait') {
              await scheduler.advance(op.ms);
              continue;
            }
            const last = transitions.at(-1);
            const mustBlock = last?.to === 'open' && scheduler.now() - last.at < 1000;
            const probe = { invoked: false };
            const result = await cb
              .execute(() => {
                probe.invoked = true;
                return op.success ? ok() : fail();
              })
              .catch((e: unknown) => e);
            if (mustBlock) expect(probe.invoked).toBe(false);
            if (!probe.invoked) expect(result).toBeInstanceOf(CircuitOpenError);
          }
          const legal = new Set([
            'closed>open',
            'open>half_open',
            'half_open>open',
            'half_open>closed',
          ]);
          for (const t of transitions) expect(legal.has(`${t.from}>${t.to}`)).toBe(true);
          for (let i = 1; i < transitions.length; i += 1) {
            expect(transitions[i]?.from).toBe(transitions[i - 1]?.to);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: in closed state it never opens before minimumCalls outcomes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { maxLength: 30 }),
        fc.integer({ min: 1, max: 10 }),
        async (outcomes, minimumCalls) => {
          const { cb } = breaker({ windowSize: 10, minimumCalls, failureRateThreshold: 0.01 });
          let count = 0;
          for (const success of outcomes) {
            if (cb.state !== 'closed') break;
            await cb.execute(success ? ok : fail).catch(() => undefined);
            count += 1;
            if (count < minimumCalls) expect(cb.state).toBe('closed');
          }
        },
      ),
    );
  });
});
