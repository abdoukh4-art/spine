import { v7 as uuidv7 } from 'uuid';

/**
 * Small ports for non-determinism. Domain and application code receive these instead
 * of calling `Date.now()` / `Math.random()` / `crypto.randomUUID()` directly, which makes
 * time- and ID-dependent logic testable with fixed values.
 */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Returns a new UUIDv7 (time-ordered; good B-tree locality, ADR-0024). */
  next(): string;
}

export const systemClock: Clock = { now: () => new Date() };

export const uuidV7Generator: IdGenerator = { next: () => uuidv7() };

/** A clock fixed at a given instant that can be advanced manually (for tests and simulations). */
export class ManualClock implements Clock {
  private current: number;
  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(date: Date | string): void {
    this.current = new Date(date).getTime();
  }
}

/** Deterministic ID generator: `00000000-0000-7000-8000-000000000001`, `…002`, … */
export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `00000000-0000-7000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}
