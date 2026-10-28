import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook authentication (ADR-0017, ADR-0035). A sender proves it knows the source's shared
 * secret by sending
 *
 *     X-Spine-Timestamp: <unix seconds>
 *     X-Spine-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *
 * Signing the timestamp together with the body means a captured request can't be replayed
 * with a fresh timestamp, and the ±5 minute window bounds how long an old one stays valid.
 */
export const WEBHOOK_MAX_SKEW_SECONDS = 5 * 60;

export type SignatureFailure =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'malformed_signature'
  | 'signature_mismatch';

export interface SignatureCheck {
  secret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
  /** Current time in milliseconds (injected: the domain never reads the clock itself). */
  nowMs: number;
}

/** Computes the hex signature a sender must send (also used by tests and the docs). */
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/**
 * Verifies a webhook signature in constant time. Returns `null` when valid, otherwise the
 * reason (for logs and metrics only: the HTTP response stays a generic 401).
 */
export function verifyWebhookSignature(check: SignatureCheck): SignatureFailure | null {
  const { timestampHeader, signatureHeader } = check;
  if (!timestampHeader || !signatureHeader) return 'missing_headers';
  if (!/^\d{1,12}$/.test(timestampHeader)) return 'bad_timestamp';
  const skew = Math.abs(check.nowMs / 1000 - Number(timestampHeader));
  if (skew > WEBHOOK_MAX_SKEW_SECONDS) return 'stale_timestamp';
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(signatureHeader.trim());
  if (!m?.[1]) return 'malformed_signature';
  const expected = Buffer.from(signWebhook(check.secret, timestampHeader, check.rawBody), 'hex');
  const received = Buffer.from(m[1], 'hex');
  // Both are 32 bytes here (regex above), which timingSafeEqual requires.
  return timingSafeEqual(expected, received) ? null : 'signature_mismatch';
}
