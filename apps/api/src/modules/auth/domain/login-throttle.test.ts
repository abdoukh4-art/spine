import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decideThrottle, normalizeEmail, type WindowCount } from './login-throttle.js';

const ip = (count: number, resetInMs = 30_000): WindowCount => ({
  dimension: 'ip',
  count,
  resetInMs,
});
const user = (count: number, resetInMs = 30_000): WindowCount => ({
  dimension: 'username',
  count,
  resetInMs,
});

describe('login throttle decisions', () => {
  it('allows attempts up to and including the limit', () => {
    expect(decideThrottle([ip(10), user(10)], 10)).toEqual({ allowed: true });
  });

  it('blocks when the IP dimension exceeds the limit', () => {
    expect(decideThrottle([ip(11, 12_300), user(1)], 10)).toEqual({
      allowed: false,
      retryAfterSeconds: 13,
      exceeded: ['ip'],
    });
  });

  it('blocks when the username dimension exceeds the limit', () => {
    expect(decideThrottle([ip(1), user(11, 1_000)], 10)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      exceeded: ['username'],
    });
  });

  it('uses the longest wait when both dimensions are exceeded', () => {
    const decision = decideThrottle([ip(20, 5_000), user(12, 45_000)], 10);
    expect(decision).toEqual({
      allowed: false,
      retryAfterSeconds: 45,
      exceeded: ['ip', 'username'],
    });
  });

  it('never advertises Retry-After: 0', () => {
    expect(decideThrottle([ip(11, 0)], 10)).toMatchObject({ retryAfterSeconds: 1 });
  });

  it('property: allowed iff every dimension is within the limit; Retry-After >= 1', () => {
    const count = fc.record({
      dimension: fc.constantFrom('ip' as const, 'username' as const),
      count: fc.integer({ min: 1, max: 50 }),
      resetInMs: fc.integer({ min: 0, max: 60_000 }),
    });
    fc.assert(
      fc.property(
        fc.array(count, { maxLength: 4 }),
        fc.integer({ min: 1, max: 30 }),
        (counts, max) => {
          const decision = decideThrottle(counts, max);
          expect(decision.allowed).toBe(counts.every((c) => c.count <= max));
          if (!decision.allowed) {
            expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
            expect(decision.retryAfterSeconds).toBeLessThanOrEqual(60);
          }
        },
      ),
    );
  });
});

describe('normalizeEmail', () => {
  it('trims, lower-cases and folds compatibility characters', () => {
    expect(normalizeEmail('  Alice@Corp.TEST ')).toBe('alice@corp.test');
    expect(normalizeEmail('ａｌｉｃｅ@corp.test')).toBe('alice@corp.test');
  });

  it('property: normalization is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(normalizeEmail(normalizeEmail(s))).toBe(normalizeEmail(s));
      }),
    );
  });
});
