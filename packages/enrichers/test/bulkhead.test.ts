import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AbortedError, Bulkhead, BulkheadRejectedError } from '../src/index.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Bulkhead', () => {
  it('runs up to maxConcurrent, queues up to maxQueue and rejects the rest immediately', async () => {
    const bulkhead = new Bulkhead(2, 1);
    const gates = [deferred(), deferred(), deferred()];
    const running = gates.map((g, i) => bulkhead.execute(() => g.promise.then(() => i)));
    expect(bulkhead.inFlight).toBe(2);
    expect(bulkhead.queued).toBe(1);
    await expect(bulkhead.execute(() => Promise.resolve(99))).rejects.toBeInstanceOf(
      BulkheadRejectedError,
    );
    gates.forEach((g) => g.resolve());
    await expect(Promise.all(running)).resolves.toEqual([0, 1, 2]);
    expect(bulkhead.inFlight).toBe(0);
    expect(bulkhead.queued).toBe(0);
  });

  it('releases the slot when a call fails, and starts the next queued call', async () => {
    const bulkhead = new Bulkhead(1, 1);
    const gate = deferred();
    const first = bulkhead.execute(() =>
      gate.promise.then(() => Promise.reject(new Error('boom'))),
    );
    const second = bulkhead.execute(() => Promise.resolve('second'));
    expect(bulkhead.queued).toBe(1);
    gate.resolve();
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('second');
    expect(bulkhead.inFlight).toBe(0);
  });

  it('releases the slot when fn throws synchronously', async () => {
    const bulkhead = new Bulkhead(1, 0);
    await expect(
      bulkhead.execute(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(bulkhead.inFlight).toBe(0);
  });

  it('removes a queued call whose signal aborts', async () => {
    const bulkhead = new Bulkhead(1, 2);
    const gate = deferred();
    const first = bulkhead.execute(() => gate.promise);
    const caller = new AbortController();
    let ran = false;
    const queued = bulkhead.execute(() => {
      ran = true;
      return Promise.resolve();
    }, caller.signal);
    expect(bulkhead.queued).toBe(1);
    caller.abort(new AbortedError('cancelled'));
    await expect(queued).rejects.toThrow('cancelled');
    expect(bulkhead.queued).toBe(0);
    gate.resolve();
    await first;
    expect(ran).toBe(false);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const caller = new AbortController();
    caller.abort(new AbortedError('early'));
    await expect(
      new Bulkhead(1, 1).execute(() => Promise.resolve(), caller.signal),
    ).rejects.toThrow('early');
  });

  it('a started queued call ignores a later abort of its signal', async () => {
    const bulkhead = new Bulkhead(1, 1);
    const gate = deferred();
    const first = bulkhead.execute(() => gate.promise);
    const caller = new AbortController();
    const second = bulkhead.execute(() => Promise.resolve('done'), caller.signal);
    gate.resolve();
    await first;
    caller.abort();
    await expect(second).resolves.toBe('done');
  });

  it('rejects invalid sizes', () => {
    expect(() => new Bulkhead(0, 1)).toThrow(RangeError);
    expect(() => new Bulkhead(1, -1)).toThrow(RangeError);
  });

  it('property: never exceeds maxConcurrent / maxQueue, settles every call, frees every slot', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 5 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 25 }),
        async (s, maxConcurrent, maxQueue, outcomes) => {
          const bulkhead = new Bulkhead(maxConcurrent, maxQueue);
          let maxSeenInFlight = 0;
          let maxSeenQueued = 0;
          const observe = (): void => {
            maxSeenInFlight = Math.max(maxSeenInFlight, bulkhead.inFlight);
            maxSeenQueued = Math.max(maxSeenQueued, bulkhead.queued);
          };
          const settled = { ok: 0, failed: 0, rejected: 0 };
          const calls = outcomes.map((success, i) =>
            // Arrivals are interleaved with completions by the fast-check scheduler.
            s
              .schedule(Promise.resolve(), `arrive#${i}`)
              .then(() => {
                const p = bulkhead.execute(() => {
                  observe();
                  return s.schedule(Promise.resolve(success), `finish#${i}`).then((good) => {
                    observe();
                    if (!good) throw new Error('provider failed');
                    return i;
                  });
                });
                observe();
                return p;
              })
              .then(
                () => void (settled.ok += 1),
                (e: unknown) => {
                  if (e instanceof BulkheadRejectedError) settled.rejected += 1;
                  else settled.failed += 1;
                },
              ),
          );
          // Release scheduled tasks (in a random order) until every call has settled.
          await s.waitFor(Promise.all(calls));

          expect(maxSeenInFlight).toBeLessThanOrEqual(maxConcurrent);
          expect(maxSeenQueued).toBeLessThanOrEqual(maxQueue);
          expect(settled.ok + settled.failed + settled.rejected).toBe(outcomes.length);
          expect(settled.ok + settled.failed).toBeGreaterThanOrEqual(
            Math.min(outcomes.length, maxConcurrent),
          );
          expect(bulkhead.inFlight).toBe(0);
          expect(bulkhead.queued).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});
