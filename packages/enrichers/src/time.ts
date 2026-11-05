/**
 * Time is a dependency (ADR-0014): every primitive in this package reads the clock and
 * schedules timers through a {@link Scheduler}, never through `Date.now()` / `setTimeout`
 * directly. Production code uses {@link realScheduler}; tests use the
 * `VirtualScheduler`, which only moves when the test says so, so no test ever sleeps.
 */

/** Reads the time and schedules one-shot timers. */
export interface Scheduler {
  /** Milliseconds since the epoch (or since the start of a virtual timeline). */
  now(): number;
  /**
   * Calls `callback` once after `delayMs` milliseconds.
   * @returns a function that cancels the timer (calling it after the timer fired is a no-op).
   */
  setTimer(callback: () => void, delayMs: number): () => void;
}

/** The wall clock and Node's timers. */
export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

/** Thrown (or used as the abort reason) when the caller cancelled the operation. */
export class AbortedError extends Error {
  constructor(message = 'the operation was aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

/**
 * True for errors that mean "the caller gave up", as opposed to "the provider failed":
 * our own {@link AbortedError} and the platform's `AbortError` DOMException.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof AbortedError || (error instanceof Error && error.name === 'AbortError');
}

/** The reason a signal was aborted with, normalized to an `Error`. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new AbortedError(String(reason));
}

/** Normalizes anything thrown into an `Error`. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Resolves after `delayMs` on the given scheduler. Rejects with the signal's abort reason
 * as soon as `signal` aborts, and cancels the timer so nothing is left behind.
 */
export function sleep(scheduler: Scheduler, delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cancel();
      reject(abortReason(signal as AbortSignal));
    };
    const cancel = scheduler.setTimer(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, delayMs),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
