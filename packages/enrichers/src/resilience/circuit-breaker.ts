import type { CircuitState } from '@spine/shared-schema';
import { isAbortError, realScheduler, type Scheduler } from '../time.js';
import { CircuitOpenError } from './errors.js';

export type { CircuitState } from '@spine/shared-schema';

/** Options for {@link CircuitBreaker}. Defaults are in `DEFAULT_RESILIENCE` (resilient-enricher.ts). */
export interface CircuitBreakerOptions {
  /** Open when failures / calls in the window reach this ratio (0 < x <= 1). */
  failureRateThreshold: number;
  /** Size of the rolling window: the outcomes of the last N calls. */
  windowSize: number;
  /** Never open before the window holds at least this many calls (1 <= x <= windowSize). */
  minimumCalls: number;
  /** How long to stay open before letting probes through. */
  cooldownMs: number;
  /** Concurrent probes allowed in half-open; this many successes close the circuit. */
  halfOpenMaxCalls: number;
  /** Defaults to the real scheduler. */
  scheduler?: Scheduler;
  /**
   * Which errors count as provider failures. Defaults to "everything except the caller
   * aborting": a caller giving up says nothing about the provider's health.
   */
  isFailure?: (error: unknown) => boolean;
  /** Called on every transition (wire it to a gauge and a log line). */
  onStateChange?: (change: { from: CircuitState; to: CircuitState; at: number }) => void;
}

/** A permission to make one call, tied to the breaker "generation" it was granted in. */
interface Ticket {
  generation: number;
  probe: boolean;
}

/**
 * Count-based circuit breaker (Nygard, _Release It!_; ADR-0014).
 *
 * ```
 *   closed ──(failure rate ≥ threshold over the last N calls, ≥ minimumCalls)──▶ open
 *   open ──(cooldownMs elapsed)──▶ half_open          (evaluated lazily, on the next read/call)
 *   half_open ──(halfOpenMaxCalls probes succeed)──▶ closed
 *   half_open ──(any probe fails)──▶ open             (the cooldown starts again)
 * ```
 *
 * While open, calls fail fast with {@link CircuitOpenError} without touching the provider:
 * that is the whole point. It gives a struggling provider room to recover and keeps our
 * own latency low. Every transition bumps a generation counter. A call that started in an
 * earlier generation (say, closed) and finishes after the breaker moved on is ignored, so
 * a slow straggler can't close or re-open the circuit by accident.
 */
export class CircuitBreaker {
  private current: CircuitState = 'closed';
  private generation = 0;
  private outcomes: boolean[] = []; // true = failure, oldest first
  private openedAt = 0;
  private probesInFlight = 0;
  private probeSuccesses = 0;
  private readonly scheduler: Scheduler;
  private readonly isFailure: (error: unknown) => boolean;

  /** @throws RangeError when the options are inconsistent. */
  constructor(private readonly options: CircuitBreakerOptions) {
    validateOptions(options);
    this.scheduler = options.scheduler ?? realScheduler;
    this.isFailure = options.isFailure ?? ((error) => !isAbortError(error));
  }

  /** Current state (moves open → half_open when the cooldown has elapsed). */
  get state(): CircuitState {
    this.refresh();
    return this.current;
  }

  /** Failure ratio over the current window (0 when empty). For diagnostics. */
  get failureRate(): number {
    if (this.outcomes.length === 0) return 0;
    return this.outcomes.filter(Boolean).length / this.outcomes.length;
  }

  /**
   * Runs `fn` if the circuit allows it.
   * @throws CircuitOpenError without calling `fn` when open (or half-open and out of probe slots).
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const ticket = this.acquire();
    let value: T;
    try {
      value = await fn();
    } catch (error) {
      if (this.isFailure(error)) this.onFailure(ticket);
      else this.release(ticket);
      throw error;
    }
    this.onSuccess(ticket);
    return value;
  }

  private acquire(): Ticket {
    this.refresh();
    if (this.current === 'open') {
      const remaining = this.openedAt + this.options.cooldownMs - this.scheduler.now();
      throw new CircuitOpenError(Math.max(0, remaining));
    }
    if (this.current === 'half_open') {
      if (this.probesInFlight + this.probeSuccesses >= this.options.halfOpenMaxCalls) {
        throw new CircuitOpenError(0);
      }
      this.probesInFlight += 1;
      return { generation: this.generation, probe: true };
    }
    return { generation: this.generation, probe: false };
  }

  private onSuccess(ticket: Ticket): void {
    if (ticket.generation !== this.generation) return;
    if (!ticket.probe) {
      this.record(false);
      return;
    }
    this.probesInFlight -= 1;
    this.probeSuccesses += 1;
    if (this.probeSuccesses >= this.options.halfOpenMaxCalls) this.transition('closed');
  }

  private onFailure(ticket: Ticket): void {
    if (ticket.generation !== this.generation) return;
    if (ticket.probe) {
      this.transition('open');
      return;
    }
    this.record(true);
    const failures = this.outcomes.filter(Boolean).length;
    if (
      this.outcomes.length >= this.options.minimumCalls &&
      failures / this.outcomes.length >= this.options.failureRateThreshold
    ) {
      this.transition('open');
    }
  }

  /** A call that ended in a non-failure error (caller abort): free its probe slot, record nothing. */
  private release(ticket: Ticket): void {
    if (ticket.generation === this.generation && ticket.probe) this.probesInFlight -= 1;
  }

  private record(failure: boolean): void {
    this.outcomes.push(failure);
    if (this.outcomes.length > this.options.windowSize) this.outcomes.shift();
  }

  private refresh(): void {
    if (
      this.current === 'open' &&
      this.scheduler.now() - this.openedAt >= this.options.cooldownMs
    ) {
      this.transition('half_open');
    }
  }

  private transition(to: CircuitState): void {
    const from = this.current;
    this.current = to;
    this.generation += 1;
    this.outcomes = [];
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
    const at = this.scheduler.now();
    if (to === 'open') this.openedAt = at;
    this.options.onStateChange?.({ from, to, at });
  }
}

function validateOptions(o: CircuitBreakerOptions): void {
  const problems: string[] = [];
  if (!(o.failureRateThreshold > 0 && o.failureRateThreshold <= 1)) {
    problems.push('failureRateThreshold must be in (0, 1]');
  }
  if (!Number.isInteger(o.windowSize) || o.windowSize < 1) {
    problems.push('windowSize must be an integer >= 1');
  }
  if (!Number.isInteger(o.minimumCalls) || o.minimumCalls < 1 || o.minimumCalls > o.windowSize) {
    problems.push('minimumCalls must be an integer in [1, windowSize]');
  }
  if (!(o.cooldownMs >= 0)) problems.push('cooldownMs must be >= 0');
  if (!Number.isInteger(o.halfOpenMaxCalls) || o.halfOpenMaxCalls < 1) {
    problems.push('halfOpenMaxCalls must be an integer >= 1');
  }
  if (problems.length > 0)
    throw new RangeError(`invalid circuit breaker options: ${problems.join('; ')}`);
}
