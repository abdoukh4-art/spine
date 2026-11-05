import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InFlightLimit } from '../../../src/platform/http/in-flight-limit.js';

describe('InFlightLimit', () => {
  it('hands out at most `max` slots and frees one on release', () => {
    const limit = new InFlightLimit(2);
    const a = limit.tryAcquire();
    const b = limit.tryAcquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(limit.tryAcquire()).toBeNull();
    a?.();
    expect(limit.current).toBe(1);
    expect(limit.tryAcquire()).not.toBeNull();
  });

  it('ignores a second release of the same slot (finished + aborted paths)', () => {
    const limit = new InFlightLimit(1);
    const release = limit.tryAcquire();
    release?.();
    release?.();
    expect(limit.current).toBe(0);
    expect(limit.tryAcquire()).not.toBeNull();
    expect(limit.tryAcquire()).toBeNull();
  });

  it('rejects a non-positive or fractional maximum', () => {
    expect(() => new InFlightLimit(0)).toThrow(RangeError);
    expect(() => new InFlightLimit(1.5)).toThrow(RangeError);
  });

  it('never exceeds max and never goes negative, whatever the order of acquires and releases', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.oneof(fc.constant('acquire' as const), fc.nat({ max: 20 })), {
          maxLength: 200,
        }),
        (max, ops) => {
          const limit = new InFlightLimit(max);
          const held: (() => void)[] = [];
          for (const op of ops) {
            if (op === 'acquire') {
              const release = limit.tryAcquire();
              if (release) held.push(release);
            } else if (held.length > 0) {
              // Release some held slot, possibly one already released (idempotency).
              held[op % held.length]?.();
            }
            expect(limit.current).toBeGreaterThanOrEqual(0);
            expect(limit.current).toBeLessThanOrEqual(max);
          }
        },
      ),
    );
  });
});
