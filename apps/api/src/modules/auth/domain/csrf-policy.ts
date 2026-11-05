/**
 * CSRF policy for the two cookie-authenticated endpoints, `/auth/refresh` and
 * `/auth/logout` (ADR-0016, ADR-0061).
 *
 * Every other endpoint authenticates with an `Authorization: Bearer` header, which a
 * browser never attaches on its own, so it can't be forged cross-site. The refresh cookie,
 * however, IS attached automatically. Three independent layers protect it:
 * 1. `SameSite=Strict` on the cookie (set elsewhere);
 * 2. a custom header `X-Spine-CSRF: 1`: an HTML form can't set custom headers, and a
 *    cross-origin `fetch` that sets one triggers a CORS preflight, which we deny;
 * 3. an `Origin` header that is on the allow-list. Browsers always send `Origin` on POST,
 *    so a missing Origin is rejected in EVERY environment (no test-only exemption: tests
 *    must exercise the production rule).
 */
export const CSRF_HEADER = 'x-spine-csrf';
export const CSRF_HEADER_VALUE = '1';

/** The request facts the policy needs. Header values are as received (possibly absent). */
export interface CsrfInput {
  csrfHeader: string | undefined;
  origin: string | undefined;
}

/** Outcome of a CSRF check. Reasons are logged, never echoed in detail to the client. */
export type CsrfVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing_csrf_header' | 'missing_origin' | 'origin_not_allowed' };

/**
 * Applies the policy. Origins are compared exactly (scheme + host + port), so
 * `https://spine.test.evil.example` doesn't match `https://spine.test`. The literal
 * `null` origin (sandboxed iframes, `file://`) is never allowed.
 */
export function checkCsrf(input: CsrfInput, allowedOrigins: readonly string[]): CsrfVerdict {
  if (input.csrfHeader !== CSRF_HEADER_VALUE) return { ok: false, reason: 'missing_csrf_header' };
  if (input.origin === undefined || input.origin === '') {
    return { ok: false, reason: 'missing_origin' };
  }
  if (input.origin === 'null' || !allowedOrigins.includes(input.origin)) {
    return { ok: false, reason: 'origin_not_allowed' };
  }
  return { ok: true };
}
