/**
 * Password policy (OWASP ASVS V2.1, NIST SP 800-63B §5.1.1.2).
 *
 * Modern guidance favours LENGTH over composition rules ("one upper, one digit, one
 * symbol"): composition rules push people towards predictable patterns like `Password1!`.
 * So the policy is:
 * - 12 to 128 characters, counted as Unicode code points (an emoji is one character);
 *   the upper bound also caps the work an attacker can force argon2 to do per request.
 * - not a well-known password (a tiny built-in deny-list; a breached-password check
 *   against a k-anonymity API is a roadmap item);
 * - must not contain the account's email local part (e.g. `alice` in `alice@corp.test`).
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** A small deny-list of the most common long-enough passwords. Compared case-insensitively. */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '123456789012',
  'password1234',
  'password123!',
  'qwertyuiop12',
  'qwertyuiopas',
  'iloveyou1234',
  'administrator',
  'changeme1234',
  'letmein12345',
  'welcome12345',
  'passwordpassword',
]);

/** Why a candidate password was rejected. Codes are stable; messages are for humans. */
export interface PasswordViolation {
  code: 'too_short' | 'too_long' | 'common' | 'contains_email';
  message: string;
}

/** Context used for "must not contain personal data" checks. */
export interface PasswordContext {
  email?: string;
}

/** Length in Unicode code points (so `'🔒'.length === 2` does not count twice). */
export function codePointLength(value: string): number {
  let count = 0;
  // `for…of` over a string iterates code points, not UTF-16 code units.
  for (const _codePoint of value) count += 1;
  return count;
}

/**
 * Checks a candidate password against the policy.
 * @returns every violation found (an empty array means the password is acceptable).
 */
export function checkPasswordPolicy(
  password: string,
  context: PasswordContext = {},
): PasswordViolation[] {
  const violations: PasswordViolation[] = [];
  const length = codePointLength(password);
  if (length < PASSWORD_MIN_LENGTH) {
    violations.push({
      code: 'too_short',
      message: `must be at least ${PASSWORD_MIN_LENGTH} characters`,
    });
  }
  if (length > PASSWORD_MAX_LENGTH) {
    violations.push({
      code: 'too_long',
      message: `must be at most ${PASSWORD_MAX_LENGTH} characters`,
    });
  }
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) {
    violations.push({ code: 'common', message: 'is a well-known password' });
  }
  const localPart = context.email?.split('@')[0]?.toLowerCase() ?? '';
  // Very short local parts ("a@x.test") would reject too many legitimate passwords.
  if (localPart.length >= 3 && lowered.includes(localPart)) {
    violations.push({ code: 'contains_email', message: 'must not contain your email name' });
  }
  return violations;
}
