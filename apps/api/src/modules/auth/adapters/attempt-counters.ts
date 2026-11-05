import type { Redis } from 'ioredis';
import type { Clock } from '../../../platform/runtime.js';
import type { AttemptCounter } from '../application/ports.js';

/**
 * Fixed-window counter in Redis (ADR-0063). One round trip: a Lua script increments the
 * key, sets its expiry on the first hit, and returns the count and the remaining TTL.
 * Running it as a script makes INCR + PEXPIRE atomic, so a crash between the two can't
 * leave a counter that never expires (which would lock an account out forever).
 * Shared by all API replicas, so limits hold cluster-wide.
 */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}
`;

/** Redis-backed {@link AttemptCounter}. */
export class RedisAttemptCounter implements AttemptCounter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'spine:login-attempts:',
  ) {}

  /** Records one attempt and returns the window's count (including this one). */
  async hit(key: string, windowMs: number): Promise<{ count: number; resetInMs: number }> {
    // Redis returns Lua numbers as integers; the script always returns a 2-element array.
    const [count, resetInMs] = (await this.redis.eval(
      HIT_SCRIPT,
      1,
      `${this.prefix}${key}`,
      windowMs,
    )) as [number, number];
    return { count, resetInMs };
  }
}

/**
 * Uses `primary` (Redis) and falls back to `fallback` (in-memory) when it errors, so a
 * Redis outage degrades throttling to per-process limits instead of either failing every
 * login (fail-closed) or disabling throttling entirely (fail-open). See ADR-0063.
 */
export class FallbackAttemptCounter implements AttemptCounter {
  constructor(
    private readonly primary: AttemptCounter,
    private readonly fallback: AttemptCounter,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Records one attempt, preferring the primary store. */
  async hit(key: string, windowMs: number): Promise<{ count: number; resetInMs: number }> {
    try {
      return await this.primary.hit(key, windowMs);
    } catch (err) {
      this.onError(err);
      return this.fallback.hit(key, windowMs);
    }
  }
}

/**
 * In-process {@link AttemptCounter} for tests and single-node development (no Redis).
 * Limits are per process, so N replicas would allow N× the attempts: fine for dev only.
 */
export class MemoryAttemptCounter implements AttemptCounter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly maxKeys = 100_000,
  ) {}

  /** Records one attempt and returns the window's count (including this one). */
  hit(key: string, windowMs: number): Promise<{ count: number; resetInMs: number }> {
    const now = this.clock.now().getTime();
    let window = this.windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.sweep(now);
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return Promise.resolve({ count: window.count, resetInMs: window.resetAt - now });
  }

  /** Drops expired windows; if still full, drops everything (fail-open beats OOM). */
  private sweep(now: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}
