import type { Scheduler } from '../time.js';

interface VirtualTimer {
  id: number;
  at: number;
  callback: () => void;
}

/**
 * A {@link Scheduler} whose time only moves when a test calls {@link advance} or
 * {@link runAll}. Timers fire in due-time order (ties in creation order), and pending
 * promise callbacks are flushed between timers, so `await`-based code behaves as it would
 * in real time, just instantly. This is how the resilience tests "wait" ten seconds for a
 * circuit breaker cooldown in microseconds (ADR-0021: no sleeping in tests).
 */
export class VirtualScheduler implements Scheduler {
  private time: number;
  private nextId = 0;
  private timers: VirtualTimer[] = [];

  constructor(startMs = 0) {
    this.time = startMs;
  }

  /** Current virtual time in ms. */
  now(): number {
    return this.time;
  }

  /** Schedules `callback` at `now() + delayMs` (negative delays count as 0). */
  setTimer(callback: () => void, delayMs: number): () => void {
    const timer: VirtualTimer = {
      id: this.nextId++,
      at: this.time + Math.max(0, delayMs),
      callback,
    };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /** Number of timers not yet fired or cancelled (0 means nothing leaked). */
  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Moves time forward by `ms`, firing every timer that falls due on the way. */
  async advance(ms: number): Promise<void> {
    const target = this.time + Math.max(0, ms);
    for (;;) {
      await flushPromises();
      const next = this.nextDue(target);
      if (!next) break;
      this.fire(next);
    }
    this.time = target;
    await flushPromises();
  }

  /** Fires timers until none are left (or `maxTimers` fired, to stop runaway loops). */
  async runAll(maxTimers = 10_000): Promise<void> {
    for (let fired = 0; fired < maxTimers; fired += 1) {
      await flushPromises();
      const next = this.nextDue(Number.POSITIVE_INFINITY);
      if (!next) return;
      this.fire(next);
    }
    throw new Error(
      `runAll: more than ${maxTimers} timers fired; is something rescheduling forever?`,
    );
  }

  private nextDue(limit: number): VirtualTimer | undefined {
    let best: VirtualTimer | undefined;
    for (const t of this.timers) {
      if (t.at > limit) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    return best;
  }

  private fire(timer: VirtualTimer): void {
    this.timers = this.timers.filter((t) => t !== timer);
    this.time = Math.max(this.time, timer.at);
    timer.callback();
  }
}

/**
 * Lets every already-queued promise callback run. `setImmediate` fires after the
 * microtask queue is drained. That's a real macrotask turn, but not a sleep.
 */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
