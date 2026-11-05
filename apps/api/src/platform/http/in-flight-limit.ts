/**
 * A per-process cap on concurrent requests (a bulkhead for an endpoint group, ADR-0093).
 *
 * Little's law: requests in the system = arrival rate × time in the system. When arrivals outrun
 * the database, the excess doesn't disappear, it waits, and every accepted request gets slower.
 * Capping concurrency turns that hidden queue into an immediate `503`, so accepted requests keep
 * their latency and the client learns at once to back off.
 */
export class InFlightLimit {
  private inFlight = 0;

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
  }

  /** Requests currently holding a slot. */
  get current(): number {
    return this.inFlight;
  }

  /**
   * Takes a slot, or returns `null` when all `max` are taken. The returned `release` is
   * idempotent, so it's safe to call from both a "finished" and an "aborted" path.
   */
  tryAcquire(): (() => void) | null {
    if (this.inFlight >= this.max) return null;
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
  }
}
