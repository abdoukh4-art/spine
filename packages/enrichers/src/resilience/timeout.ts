import { abortReason, realScheduler, toError, type Scheduler } from '../time.js';
import { TimeoutError } from './errors.js';

/** Options for {@link withTimeout}. */
export interface TimeoutOptions {
  /** Defaults to {@link realScheduler}. */
  scheduler?: Scheduler;
  /** The caller's signal. Aborting it aborts the attempt with the caller's reason. */
  signal?: AbortSignal | undefined;
}

/**
 * Runs `fn` with a time budget of `timeoutMs` (ADR-0014, the innermost layer).
 *
 * - `fn` receives an `AbortSignal`. When the budget runs out, that signal is aborted with
 *   the same {@link TimeoutError} the returned promise rejects with, so a well-behaved
 *   provider stops its work (a socket, a query) instead of running on in the background.
 * - If the caller's `signal` aborts first, the attempt is aborted with the caller's reason.
 * - The returned promise settles exactly once, and the timer and the abort listener are
 *   always cleaned up, whichever way it settles.
 * - A provider that ignores its signal can't hold the caller: the promise still rejects on time.
 */
export function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: TimeoutOptions = {},
): Promise<T> {
  const scheduler = options.scheduler ?? realScheduler;
  const parent = options.signal;
  if (parent?.aborted) return Promise.reject(abortReason(parent));

  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cancelTimer();
      parent?.removeEventListener('abort', onParentAbort);
      action();
    };
    const fail = (error: Error): void => {
      finish(() => {
        controller.abort(error);
        reject(error);
      });
    };
    const onParentAbort = (): void => {
      fail(abortReason(parent as AbortSignal));
    };
    const cancelTimer = scheduler.setTimer(() => {
      fail(new TimeoutError(timeoutMs));
    }, timeoutMs);
    parent?.addEventListener('abort', onParentAbort, { once: true });

    let attempt: Promise<T>;
    try {
      attempt = fn(controller.signal);
    } catch (error) {
      attempt = Promise.reject(toError(error));
    }
    attempt.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(toError(error));
        });
      },
    );
  });
}
