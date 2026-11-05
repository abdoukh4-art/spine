import { OverloadedError } from '../../../platform/errors.js';
import type { Clock } from '../../../platform/runtime.js';
import type { BacklogProbe } from './ports.js';

/** Options for {@link BackpressureGuard}. */
export interface BackpressureOptions {
  probe: BacklogProbe;
  clock: Clock;
  /** Reject new work when the backlog is ABOVE this (`INGEST_MAX_BACKLOG`). */
  maxBacklog: number;
  /** How long a measured backlog is reused (default 1 s). */
  cacheMs?: number;
  /** `Retry-After` sent to rejected clients, in seconds (ADR-0024: 5). */
  retryAfterSeconds?: number;
}

/**
 * Load shedding at the front door (ADR-0024, ADR-0034). If the outbox holds more undispatched
 * events than the pipeline can absorb, accepting more alerts only makes every alert later;
 * a fast `503 + Retry-After` lets well-behaved senders back off and retry.
 *
 * Counting the backlog is a `COUNT(*)` over a partial index: cheap, but not free at 200 req/s.
 * The value is cached for about a second, and concurrent callers share one in-flight query
 * (no thundering herd when the cache expires).
 */
export class BackpressureGuard {
  private cached: { value: number; at: number } | null = null;
  private inflight: Promise<number> | null = null;
  private readonly cacheMs: number;
  private readonly retryAfterSeconds: number;

  constructor(private readonly options: BackpressureOptions) {
    this.cacheMs = options.cacheMs ?? 1000;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 5;
  }

  /** The (possibly cached) backlog size. */
  async backlog(): Promise<number> {
    const now = this.options.clock.now().getTime();
    if (this.cached && now - this.cached.at < this.cacheMs) return this.cached.value;
    this.inflight ??= this.options
      .probe()
      .then((value) => {
        this.cached = { value, at: this.options.clock.now().getTime() };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** True while the backlog is at or below the threshold (readiness check `ingest-backlog`). */
  async healthy(): Promise<boolean> {
    return (await this.backlog()) <= this.options.maxBacklog;
  }

  /** @throws OverloadedError (503 + Retry-After) when the backlog exceeds the threshold. */
  async check(): Promise<void> {
    if (!(await this.healthy())) {
      throw new OverloadedError(
        'ingestion is temporarily overloaded; retry later',
        this.retryAfterSeconds,
      );
    }
  }
}
