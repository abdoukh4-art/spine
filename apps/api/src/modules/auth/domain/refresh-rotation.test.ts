import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decideRefresh, refreshExpiry, type RefreshTokenState } from './refresh-rotation.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const later = new Date('2026-10-29T12:00:00.000Z');
const live: RefreshTokenState = { revokedAt: null, expiresAt: later, userDisabled: false };

describe('refresh-token rotation rules', () => {
  it('rotates a live token', () => {
    expect(decideRefresh(live, now)).toEqual({ action: 'rotate' });
  });

  it('rejects unknown tokens without side effects', () => {
    expect(decideRefresh(null, now)).toEqual({ action: 'reject', reason: 'unknown' });
  });

  it('rejects expired tokens (expiry is exclusive)', () => {
    expect(decideRefresh({ ...live, expiresAt: now }, now)).toEqual({
      action: 'reject',
      reason: 'expired',
    });
  });

  it('revokes the family when a revoked token is presented again', () => {
    expect(decideRefresh({ ...live, revokedAt: now }, now)).toEqual({
      action: 'revoke_family',
      reason: 'reuse_detected',
    });
  });

  it('revokes the family when the user was disabled', () => {
    expect(decideRefresh({ ...live, userDisabled: true }, now)).toEqual({
      action: 'revoke_family',
      reason: 'user_disabled',
    });
  });

  it('property: a revoked token never rotates and always counts as reuse, even when expired', () => {
    fc.assert(
      fc.property(
        fc.date({ noInvalidDate: true }),
        fc.date({ noInvalidDate: true }),
        fc.date({ noInvalidDate: true }),
        fc.boolean(),
        (revokedAt, expiresAt, at, userDisabled) => {
          expect(decideRefresh({ revokedAt, expiresAt, userDisabled }, at)).toEqual({
            action: 'revoke_family',
            reason: 'reuse_detected',
          });
        },
      ),
    );
  });

  it('property: rotation happens only for live, unexpired tokens of enabled users', () => {
    fc.assert(
      fc.property(
        fc.option(fc.date({ noInvalidDate: true })),
        fc.date({ noInvalidDate: true }),
        fc.date({ noInvalidDate: true }),
        fc.boolean(),
        (revokedAt, expiresAt, at, userDisabled) => {
          const decision = decideRefresh({ revokedAt, expiresAt, userDisabled }, at);
          const valid = revokedAt === null && expiresAt > at && !userDisabled;
          expect(decision.action === 'rotate').toBe(valid);
        },
      ),
    );
  });

  it('computes a sliding expiry', () => {
    expect(refreshExpiry(now, 3600).toISOString()).toBe('2026-10-28T13:00:00.000Z');
  });
});
