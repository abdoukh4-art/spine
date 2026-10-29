import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  backoffDelay,
  isTransientError,
  retry,
  TimeoutError,
  TransientProviderError,
  VirtualScheduler,
} from '../src/index.js';

const transient = (): Error => new TransientProviderError('503');

describe('backoffDelay (full jitter)', () => {
  it('is random() times min(cap, base * 2^retryIndex)', () => {
    expect(backoffDelay(0, { baseMs: 100, capMs: 1000 }, () => 0.5)).toBe(50);
    expect(backoffDelay(3, { baseMs: 100, capMs: 1000 }, () => 0.5)).toBe(400);
    expect(backoffDelay(10, { baseMs: 100, capMs: 1000 }, () => 0.5)).toBe(500);
    expect(backoffDelay(5000, { baseMs: 100, capMs: 1000 }, () => 0.999)).toBeCloseTo(999);
  });

  it('clamps misbehaving random sources into [0, cap]', () => {
    expect(backoffDelay(0, { baseMs: 100, capMs: 1000 }, () => 7)).toBe(100);
    expect(backoffDelay(0, { baseMs: 100, capMs: 1000 }, () => -1)).toBe(0);
    expect(backoffDelay(0, { baseMs: 100, capMs: 1000 }, () => Number.NaN)).toBe(0);
  });

  it('property: always within [0, min(cap, base * 2^i)]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (i, baseMs, capMs, r) => {
          const d = backoffDelay(i, { baseMs, capMs }, () => r);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(capMs);
          expect(d).toBeLessThanOrEqual(baseMs * 2 ** i);
        },
      ),
    );
  });
});

describe('retry', () => {
  it('returns the first success without sleeping', async () => {
    let calls = 0;
    const value = await retry(
      () => {
        calls += 1;
        return Promise.resolve('ok');
      },
      { maxAttempts: 3, baseMs: 10, capMs: 100 },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries transient errors with backoff, then succeeds', async () => {
    const scheduler = new VirtualScheduler();
    const delays: number[] = [];
    let calls = 0;
    const p = retry(
      (attempt) => {
        calls += 1;
        return attempt < 3 ? Promise.reject(transient()) : Promise.resolve(attempt);
      },
      {
        maxAttempts: 5,
        baseMs: 100,
        capMs: 1000,
        random: () => 0.5,
        scheduler,
        onRetry: (info) => delays.push(info.delayMs),
      },
    );
    await scheduler.runAll();
    await expect(p).resolves.toBe(3);
    expect(calls).toBe(3);
    expect(delays).toEqual([50, 100]);
    expect(scheduler.now()).toBe(150);
  });

  it('does not retry permanent errors', async () => {
    let calls = 0;
    await expect(
      retry(
        () => {
          calls += 1;
          return Promise.reject(new Error('400 bad request'));
        },
        { maxAttempts: 5, baseMs: 1, capMs: 1 },
      ),
    ).rejects.toThrow('400');
    expect(calls).toBe(1);
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    const scheduler = new VirtualScheduler();
    let calls = 0;
    const p = retry(
      () => {
        calls += 1;
        return Promise.reject(new TimeoutError(10));
      },
      { maxAttempts: 3, baseMs: 10, capMs: 100, scheduler },
    );
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await scheduler.runAll();
    await assertion;
    expect(calls).toBe(3);
  });

  it('never starts another attempt after the caller aborts, even mid-backoff', async () => {
    const scheduler = new VirtualScheduler();
    const caller = new AbortController();
    let calls = 0;
    const p = retry(
      () => {
        calls += 1;
        return Promise.reject(transient());
      },
      {
        maxAttempts: 10,
        baseMs: 1000,
        capMs: 1000,
        random: () => 1,
        scheduler,
        signal: caller.signal,
      },
    );
    const assertion = expect(p).rejects.toBeInstanceOf(AbortedError);
    await scheduler.advance(10); // inside the first backoff sleep
    caller.abort(new AbortedError());
    await scheduler.runAll();
    await assertion;
    expect(calls).toBe(1);
  });

  it('does not retry when the attempt itself failed because of the abort', async () => {
    const caller = new AbortController();
    let calls = 0;
    await expect(
      retry(
        () => {
          calls += 1;
          caller.abort(new AbortedError());
          return Promise.reject(transient());
        },
        { maxAttempts: 5, baseMs: 1, capMs: 1, signal: caller.signal },
      ),
    ).rejects.toBeInstanceOf(TransientProviderError);
    expect(calls).toBe(1);
  });

  it('rejects an invalid maxAttempts', async () => {
    await expect(
      retry(() => Promise.resolve(1), { maxAttempts: 0, baseMs: 1, capMs: 1 }),
    ).rejects.toThrow(RangeError);
  });

  it('classifies only timeouts and transient provider errors as transient', () => {
    expect(isTransientError(new TimeoutError(1))).toBe(true);
    expect(isTransientError(transient())).toBe(true);
    expect(isTransientError(new Error('x'))).toBe(false);
    expect(isTransientError('x')).toBe(false);
  });

  it('property: attempts <= maxAttempts, delays within [0, cap], success iff a call succeeded', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.array(fc.constantFrom('ok', 'transient', 'permanent'), { minLength: 1, maxLength: 8 }),
        fc.array(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), {
          minLength: 8,
          maxLength: 8,
        }),
        async (maxAttempts, baseMs, capMs, script, randoms) => {
          const scheduler = new VirtualScheduler();
          const delays: number[] = [];
          let calls = 0;
          let r = 0;
          const p = retry(
            (attempt) => {
              calls += 1;
              const step = script[Math.min(attempt - 1, script.length - 1)];
              if (step === 'ok') return Promise.resolve(attempt);
              return Promise.reject(step === 'transient' ? transient() : new Error('permanent'));
            },
            {
              maxAttempts,
              baseMs,
              capMs,
              scheduler,
              random: () => randoms[r++ % randoms.length] ?? 0,
              onRetry: (info) => delays.push(info.delayMs),
            },
          );
          const settled = p.then(
            (v) => ({ ok: true as const, v }),
            (e: unknown) => ({ ok: false as const, e }),
          );
          await scheduler.runAll();
          const result = await settled;

          expect(calls).toBeGreaterThanOrEqual(1);
          expect(calls).toBeLessThanOrEqual(maxAttempts);
          expect(delays).toHaveLength(calls - 1);
          delays.forEach((d, i) => {
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).toBeLessThanOrEqual(Math.min(capMs, baseMs * 2 ** i));
          });
          // Model: walk the script the same way retry should.
          let expectedCalls = 0;
          let expectedOk = false;
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            expectedCalls = attempt;
            const step = script[Math.min(attempt - 1, script.length - 1)];
            if (step === 'ok') {
              expectedOk = true;
              break;
            }
            if (step === 'permanent') break;
          }
          expect(calls).toBe(expectedCalls);
          expect(result.ok).toBe(expectedOk);
        },
      ),
      { numRuns: 300 },
    );
  });
});
