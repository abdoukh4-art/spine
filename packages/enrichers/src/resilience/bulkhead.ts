import { abortReason } from '../time.js';
import { BulkheadRejectedError } from './errors.js';

interface Waiter {
  start(): void;
}

/**
 * Bulkhead (Nygard, _Release It!_; ADR-0014): caps how many calls to one provider run at
 * once, like the watertight compartments of a ship. A slow provider can then only tie up
 * its own `maxConcurrent` slots, never the whole process.
 *
 * - Up to `maxConcurrent` calls run at once.
 * - Up to `maxQueue` more wait in FIFO order.
 * - Beyond that, calls are rejected **immediately** with {@link BulkheadRejectedError}.
 *   Failing fast under overload is better than an unbounded queue that just adds latency.
 * - A slot is released whether the call succeeds or fails.
 * - A queued call whose signal aborts leaves the queue and rejects with the abort reason.
 */
export class Bulkhead {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  /** @throws RangeError when `maxConcurrent < 1` or `maxQueue < 0`. */
  constructor(
    readonly maxConcurrent: number,
    readonly maxQueue: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be an integer >= 1');
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new RangeError('maxQueue must be an integer >= 0');
    }
  }

  /** Calls currently running. */
  get inFlight(): number {
    return this.active;
  }

  /** Calls waiting for a slot. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Runs `fn` when a slot is free.
   * @throws BulkheadRejectedError when all slots are busy and the queue is full.
   */
  execute<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.maxConcurrent) return this.run(fn);
    if (this.waiting.length >= this.maxQueue) {
      return Promise.reject(new BulkheadRejectedError(this.maxConcurrent, this.maxQueue));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(abortReason(signal as AbortSignal));
      };
      const waiter: Waiter = {
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          this.run(fn).then(resolve, reject);
        },
      };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.active += 1; // synchronous: runs before the first await
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.startNext();
    }
  }

  private startNext(): void {
    while (this.active < this.maxConcurrent) {
      const next = this.waiting.shift();
      if (!next) return;
      next.start();
    }
  }
}
