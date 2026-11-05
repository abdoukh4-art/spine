import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AbortedError, sleep, TimeoutError, VirtualScheduler, withTimeout } from '../src/index.js';

describe('withTimeout', () => {
  it('resolves with the value when the call finishes in time and clears its timer', async () => {
    const scheduler = new VirtualScheduler();
    const p = withTimeout((signal) => sleep(scheduler, 50, signal).then(() => 'ok'), 100, {
      scheduler,
    });
    await scheduler.advance(50);
    await expect(p).resolves.toBe('ok');
    expect(scheduler.pendingTimers).toBe(0);
  });

  it('rejects with TimeoutError and aborts the provider signal with that same error', async () => {
    const scheduler = new VirtualScheduler();
    let seen: AbortSignal | undefined;
    const p = withTimeout(
      (signal) => {
        seen = signal;
        return new Promise<never>(() => undefined); // a provider that never answers
      },
      100,
      { scheduler },
    );
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await scheduler.advance(100);
    await assertion;
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(TimeoutError);
    expect((seen?.reason as TimeoutError).timeoutMs).toBe(100);
  });

  it('propagates the caller abort reason to the provider signal', async () => {
    const scheduler = new VirtualScheduler();
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    const p = withTimeout(
      (signal) => {
        seen = signal;
        return sleep(scheduler, 1000, signal);
      },
      5000,
      { scheduler, signal: caller.signal },
    );
    const reason = new AbortedError('shutting down');
    caller.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(seen?.reason).toBe(reason);
    expect(scheduler.pendingTimers).toBe(0);
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const caller = new AbortController();
    caller.abort(new AbortedError('gone'));
    let called = false;
    await expect(
      withTimeout(
        () => {
          called = true;
          return Promise.resolve(1);
        },
        10,
        { signal: caller.signal },
      ),
    ).rejects.toThrow('gone');
    expect(called).toBe(false);
  });

  it('turns a synchronous throw and a non-Error rejection into Error rejections', async () => {
    const scheduler = new VirtualScheduler();
    await expect(
      withTimeout(
        () => {
          throw new Error('sync boom');
        },
        10,
        { scheduler },
      ),
    ).rejects.toThrow('sync boom');
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(withTimeout(() => Promise.reject('text'), 10, { scheduler })).rejects.toThrow(
      'text',
    );
    expect(scheduler.pendingTimers).toBe(0);
  });

  it('works with the real scheduler', async () => {
    await expect(withTimeout(() => Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  it('property: settles exactly once, with the right outcome, and leaves no timer behind', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          timeoutMs: fc.integer({ min: 1, max: 500 }),
          latencyMs: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }), // undefined = never answers
          fails: fc.boolean(),
          honoursSignal: fc.boolean(),
          callerAbortAt: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }),
        }),
        async ({ timeoutMs, latencyMs, fails, honoursSignal, callerAbortAt }) => {
          const scheduler = new VirtualScheduler();
          const caller = new AbortController();
          if (callerAbortAt !== undefined) {
            scheduler.setTimer(() => caller.abort(new AbortedError('caller')), callerAbortAt);
          }
          const provider = (signal: AbortSignal): Promise<string> => {
            if (latencyMs === undefined) return new Promise<string>(() => undefined);
            return sleep(scheduler, latencyMs, honoursSignal ? signal : undefined).then(() => {
              if (fails) throw new Error('provider failed');
              return 'value';
            });
          };
          let settlements = 0;
          let outcome: unknown;
          withTimeout(provider, timeoutMs, { scheduler, signal: caller.signal }).then(
            (v) => {
              settlements += 1;
              outcome = v;
            },
            (e: unknown) => {
              settlements += 1;
              outcome = e;
            },
          );
          await scheduler.runAll();

          expect(settlements).toBe(1);
          const providerDoneAt = latencyMs ?? Number.POSITIVE_INFINITY;
          const abortAt = callerAbortAt ?? Number.POSITIVE_INFINITY;
          const first = Math.min(providerDoneAt, timeoutMs, abortAt);
          // Ties: timers fire in creation order: caller abort timer, then timeout, then provider.
          if (first === abortAt) expect(outcome).toBeInstanceOf(AbortedError);
          else if (first === timeoutMs) expect(outcome).toBeInstanceOf(TimeoutError);
          else if (fails) expect((outcome as Error).message).toBe('provider failed');
          else expect(outcome).toBe('value');
        },
      ),
      { numRuns: 300 },
    );
  });
});
