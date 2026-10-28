import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { IdentifierFingerprinter, RefreshTokenCodec } from '../application/ports.js';

/** 32 random bytes = 256 bits of entropy, encoded as 43 base64url characters. */
const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Opaque refresh tokens (ADR-0016). Only SHA-256(token) is stored: a database leak then
 * yields hashes that can't be replayed. A plain (unsalted, fast) hash is fine here, unlike
 * for passwords, because the input has 256 bits of entropy: there is nothing to brute-force.
 */
export const refreshTokenCodec: RefreshTokenCodec = {
  generate() {
    const raw = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    return { raw, hash: sha256(raw) };
  },
  hash: (raw) => sha256(raw),
  isWellFormed: (raw) => REFRESH_TOKEN_PATTERN.test(raw),
};

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Keyed fingerprints of login identifiers, for audit entries and throttle keys.
 *
 * HMAC (not a plain hash) because emails are guessable: anyone reading a plain SHA-256 could
 * confirm "was alice@corp.test attacked?" offline. The key is DERIVED from the JWT secret
 * with HKDF and a purpose label (key separation): the same secret is never used directly
 * for two jobs.
 */
export class HmacFingerprinter implements IdentifierFingerprinter {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(
      hkdfSync('sha256', secret, 'spine', 'spine.auth.identifier-fingerprint.v1', 32),
    );
  }

  /** 128-bit hex fingerprint: plenty to avoid collisions, short enough to read. */
  fingerprint(normalizedEmail: string): string {
    return createHmac('sha256', this.key)
      .update(normalizedEmail, 'utf8')
      .digest('hex')
      .slice(0, 32);
  }
}
