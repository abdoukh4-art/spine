/**
 * Refresh-token rotation rules (ADR-0016, ADR-0062), as a pure decision function.
 *
 * Every refresh token belongs to a *family* that starts at login. Each successful refresh
 * revokes the presented token and issues its successor in the same family, so a legitimate
 * client only ever holds the newest token. If a token that was ALREADY revoked is presented
 * again, two parties hold copies of the same token: one of them stole it. We can't tell
 * which one is the thief, so the only safe move is to revoke the whole family and force a
 * fresh login.
 */

/** The stored state of a presented refresh token (looked up by its SHA-256 hash). */
export interface RefreshTokenState {
  revokedAt: Date | null;
  expiresAt: Date;
  userDisabled: boolean;
}

/** What to do with a presented refresh token. */
export type RefreshDecision =
  /** Unknown hash (never issued, or garbage), or past its expiry. Nothing else to do. */
  | { action: 'reject'; reason: 'unknown' | 'expired' }
  /**
   * Reject AND revoke the whole family: either a revoked token came back (likely theft),
   * or the account was disabled after login.
   */
  | { action: 'revoke_family'; reason: 'reuse_detected' | 'user_disabled' }
  /** Valid: revoke it and issue a successor in the same family. */
  | { action: 'rotate' };

/**
 * Decides the fate of a presented refresh token. Order matters: reuse is checked BEFORE
 * expiry, so an attacker replaying an old, revoked AND expired token still trips the alarm.
 */
export function decideRefresh(state: RefreshTokenState | null, now: Date): RefreshDecision {
  if (state === null) return { action: 'reject', reason: 'unknown' };
  if (state.revokedAt !== null) return { action: 'revoke_family', reason: 'reuse_detected' };
  if (state.expiresAt.getTime() <= now.getTime()) return { action: 'reject', reason: 'expired' };
  if (state.userDisabled) return { action: 'revoke_family', reason: 'user_disabled' };
  return { action: 'rotate' };
}

/** Expiry of a newly issued refresh token (sliding: each rotation restarts the TTL). */
export function refreshExpiry(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * 1000);
}
