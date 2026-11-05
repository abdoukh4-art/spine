/**
 * Login throttling decisions (ADR-0024, ADR-0063).
 *
 * Credential stuffing comes in two shapes, so we count attempts along two dimensions:
 * - per client IP: one machine trying many accounts;
 * - per normalized username: a botnet spreading attempts on one account over many IPs.
 * Either dimension over its limit blocks the attempt. Counting happens in a fixed window
 * (simple, cheap, and good enough at 10/min); the counter store reports the attempt count
 * in the current window and how long until that window resets.
 */

/** The dimensions a login attempt is counted along. */
export type ThrottleDimension = 'ip' | 'username';

/** One dimension's counter after recording the current attempt. */
export interface WindowCount {
  dimension: ThrottleDimension;
  /** Attempts in the current window, INCLUDING this one. */
  count: number;
  /** Milliseconds until the window resets. */
  resetInMs: number;
}

/** The throttle verdict for one login attempt. */
export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; exceeded: ThrottleDimension[] };

/**
 * Combines per-dimension counts into a verdict: blocked if ANY dimension exceeds `max`,
 * with `Retry-After` being the LONGEST wait among the exceeded dimensions (retrying
 * earlier would just be blocked again).
 */
export function decideThrottle(counts: readonly WindowCount[], max: number): ThrottleDecision {
  const exceeded = counts.filter((c) => c.count > max);
  if (exceeded.length === 0) return { allowed: true };
  const longestMs = Math.max(...exceeded.map((c) => c.resetInMs));
  return {
    allowed: false,
    // Never advertise 0: a client honouring `Retry-After: 0` would hammer us immediately.
    retryAfterSeconds: Math.max(1, Math.ceil(longestMs / 1000)),
    exceeded: exceeded.map((c) => c.dimension),
  };
}

/**
 * Canonical form of a login identifier, so `Alice@Corp.test ` and `alice@corp.test` share
 * one throttle bucket and one account. NFKC folds compatibility characters (for example
 * full-width letters) into their plain forms.
 */
export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}
