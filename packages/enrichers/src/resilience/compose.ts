import type { Scheduler } from '../time.js';
import type { Bulkhead } from './bulkhead.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { retry, type RetryOptions } from './retry.js';
import { withTimeout } from './timeout.js';

/** The four layers of one provider's protection. */
export interface ResiliencePolicy {
  bulkhead: Bulkhead;
  breaker: CircuitBreaker;
  retry: Omit<RetryOptions, 'scheduler' | 'signal'>;
  /** Budget of ONE attempt (not of the whole call with its retries). */
  timeoutMs: number;
  scheduler?: Scheduler;
}

/** A call through the stack: `fn` gets a per-attempt signal; `signal` is the caller's. */
export type ResilientCall = <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

/**
 * Composes the primitives in the order fixed by ADR-0014, outermost first:
 *
 * ```
 * bulkhead → circuit breaker → retry (full jitter) → timeout (per attempt) → fn(signal)
 * ```
 *
 * - The bulkhead is outermost, so it bounds concurrency **including** retries.
 * - The breaker wraps retry, so one logical call counts once toward the failure rate, and
 *   an open breaker skips all the retries at once.
 * - The timeout is per attempt, so retry can recover from one slow attempt.
 */
export function composeResilience(policy: ResiliencePolicy): ResilientCall {
  const { bulkhead, breaker, timeoutMs, scheduler } = policy;
  return <T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> =>
    bulkhead.execute(
      () =>
        breaker.execute(() =>
          retry(() => withTimeout(fn, timeoutMs, { signal, ...(scheduler ? { scheduler } : {}) }), {
            ...policy.retry,
            signal,
            ...(scheduler ? { scheduler } : {}),
          }),
        ),
      signal,
    );
}
