import { abortReason, realScheduler, sleep, type Scheduler } from '../time.js';
import { isTransientError } from './errors.js';

/** Exponential backoff parameters. */
export interface BackoffOptions {
  /** Delay ceiling for the first retry, in ms. */
  baseMs: number;
  /** Upper bound of any single delay, in ms. */
  capMs: number;
}

/** Options for {@link retry}. */
export interface RetryOptions extends BackoffOptions {
  /** Total attempts, including the first one (1 = never retry). */
  maxAttempts: number;
  /** Uniform random number in [0, 1). Inject a seeded one in tests. Defaults to `Math.random`. */
  random?: () => number;
  /** Which errors are worth retrying. Defaults to {@link isTransientError}. */
  retryOn?: (error: unknown) => boolean;
  /** Defaults to the real scheduler. */
  scheduler?: Scheduler;
  /** The caller's signal: once aborted, no further attempt starts and the backoff sleep ends. */
  signal?: AbortSignal | undefined;
  /** Observability hook, called before each backoff sleep. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * "Full jitter" backoff (Brooker, AWS Architecture Blog, 2015):
 * `delay = random() · min(cap, base · 2^retryIndex)`, where `retryIndex` is 0 before the
 * first retry. Spreading delays over the whole interval de-synchronizes clients that failed
 * together, which is what prevents retry storms. The result is always within `[0, cap]`.
 */
export function backoffDelay(
  retryIndex: number,
  options: BackoffOptions,
  random: () => number,
): number {
  const ceiling = Math.max(0, Math.min(options.capMs, options.baseMs * 2 ** retryIndex));
  const delay = random() * ceiling;
  return Number.isFinite(delay) ? Math.min(ceiling, Math.max(0, delay)) : 0;
}

/**
 * Calls `fn` until it succeeds, it throws an error `retryOn` rejects, the attempts run out,
 * or the caller aborts (ADR-0014). The last error is rethrown unchanged, so the caller can
 * still tell a timeout from a provider error.
 *
 * @param fn receives the 1-based attempt number.
 * @throws RangeError when `maxAttempts < 1`.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be an integer >= 1');
  }
  const random = options.random ?? Math.random;
  const retryOn = options.retryOn ?? isTransientError;
  const scheduler = options.scheduler ?? realScheduler;
  const { signal } = options;

  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await fn(attempt);
    } catch (error) {
      const giveUp = attempt >= options.maxAttempts || signal?.aborted === true || !retryOn(error);
      if (giveUp) throw error;
      const delayMs = backoffDelay(attempt - 1, options, random);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(scheduler, delayMs, signal);
    }
  }
}
