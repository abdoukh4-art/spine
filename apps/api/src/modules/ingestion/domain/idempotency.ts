import { createHash } from 'node:crypto';

/**
 * Idempotency-Key rules (ADR-0012, ADR-0033), as pure functions.
 *
 * A record is identified by `(scope, key)`. The scope is the principal that sent the request
 * (`user:<id>` or `webhook:<sourceId>`), so two clients can pick the same key without
 * colliding. The request hash tells "a retry of the same request" (replay the stored response)
 * apart from "a different request reusing a key" (409).
 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Visible ASCII, 1–255 characters (IETF draft: a key is an opaque string). */
export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/** Scope for a user principal. */
export function userScope(userId: string): string {
  return `user:${userId}`;
}

/** Scope for a webhook source. */
export function webhookScope(sourceId: string): string {
  return `webhook:${sourceId}`;
}

/**
 * JSON with object keys sorted recursively, so `{"a":1,"b":2}` and `{"b":2,"a":1}` (the same
 * request, re-serialized by a different HTTP client) hash identically.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  const text = JSON.stringify(value) as string | undefined;
  return text ?? 'null';
}

/** sha256 of a request body. Strings (raw webhook bodies) are hashed byte-for-byte. */
export function requestHash(body: unknown): Buffer {
  const text = typeof body === 'string' ? body : stableStringify(body);
  return createHash('sha256').update(text, 'utf8').digest();
}

/** The instant before which records are expired. */
export function idempotencyExpiry(now: Date): Date {
  return new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
}
