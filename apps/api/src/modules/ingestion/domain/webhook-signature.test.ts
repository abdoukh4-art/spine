import { describe, expect, it } from 'vitest';
import {
  idempotencyExpiry,
  isValidIdempotencyKey,
  requestHash,
  stableStringify,
  userScope,
  webhookScope,
} from './idempotency.js';
import { signWebhook, verifyWebhookSignature, type SignatureCheck } from './webhook-signature.js';

const secret = 'test-webhook-secret-0123456789abcdef';
const now = Date.parse('2026-10-28T10:00:00Z');
const ts = String(now / 1000);
const body = '{"event_type":"alert"}';

function check(overrides: Partial<SignatureCheck> = {}): SignatureCheck {
  return {
    secret,
    timestampHeader: ts,
    signatureHeader: `sha256=${signWebhook(secret, ts, body)}`,
    rawBody: body,
    nowMs: now,
    ...overrides,
  };
}

describe('verifyWebhookSignature', () => {
  it('accepts a correct signature within the window', () => {
    expect(verifyWebhookSignature(check())).toBeNull();
    expect(verifyWebhookSignature(check({ nowMs: now + 299_000 }))).toBeNull();
  });

  it.each([
    ['missing_headers', { signatureHeader: undefined }],
    ['missing_headers', { timestampHeader: undefined }],
    ['bad_timestamp', { timestampHeader: '10:00' }],
    ['stale_timestamp', { nowMs: now + 301_000 }],
    ['stale_timestamp', { nowMs: now - 301_000 }],
    ['malformed_signature', { signatureHeader: 'sha1=abc' }],
    ['malformed_signature', { signatureHeader: 'sha256=xyz' }],
    ['signature_mismatch', { rawBody: `${body} ` }],
    ['signature_mismatch', { secret: 'another-secret-0123456789abcdefghij' }],
  ] as const)('rejects with %s', (reason, overrides) => {
    expect(verifyWebhookSignature(check(overrides))).toBe(reason);
  });

  it('binds the timestamp into the signature (no replay with a fresh timestamp)', () => {
    const fresh = String(now / 1000 + 60);
    expect(verifyWebhookSignature(check({ timestampHeader: fresh, nowMs: now + 60_000 }))).toBe(
      'signature_mismatch',
    );
  });
});

describe('idempotency helpers', () => {
  it('validates keys: 1–255 visible ASCII characters', () => {
    expect(isValidIdempotencyKey('order-123_ABC')).toBe(true);
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('has space')).toBe(false);
    expect(isValidIdempotencyKey('x'.repeat(256))).toBe(false);
  });

  it('hashes semantically equal JSON bodies identically', () => {
    expect(stableStringify({ b: 2, a: [1, { d: undefined, c: null }] })).toBe(
      '{"a":[1,{"c":null}],"b":2}',
    );
    expect(requestHash({ a: 1, b: 2 }).equals(requestHash({ b: 2, a: 1 }))).toBe(true);
    expect(requestHash({ a: 1 }).equals(requestHash({ a: 2 }))).toBe(false);
    expect(requestHash('raw body').length).toBe(32);
    expect(stableStringify([undefined])).toBe('[null]');
    expect(stableStringify(undefined)).toBe('null');
  });

  it('scopes keys per principal and expires them after 24 h', () => {
    expect(userScope('u1')).toBe('user:u1');
    expect(webhookScope('suricata')).toBe('webhook:suricata');
    expect(idempotencyExpiry(new Date('2026-10-28T10:00:00Z')).toISOString()).toBe(
      '2026-10-27T10:00:00.000Z',
    );
  });
});
