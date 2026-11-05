import { describe, expect, it, vi } from 'vitest';
import { ManualClock, SequentialIdGenerator } from '../../../platform/runtime.js';
import { Argon2PasswordHasher } from './argon2-hasher.js';
import { FallbackAttemptCounter, MemoryAttemptCounter } from './attempt-counters.js';
import { HmacFingerprinter, refreshTokenCodec } from './crypto.js';
import { JwtAccessTokenService } from './jwt-access-tokens.js';
import { escapeLike } from './postgres-audit.js';

const SECRET = 'unit-test-secret-that-is-at-least-32-chars';

describe('JwtAccessTokenService', () => {
  const clock = new ManualClock('2026-10-28T10:00:00Z');
  const service = new JwtAccessTokenService({
    secret: SECRET,
    ttlSeconds: 900,
    clock,
    ids: new SequentialIdGenerator(),
  });
  const user = { id: '0190a0a0-0000-7000-8000-000000000001', role: 'viewer' as const };

  it('round-trips claims and expires exactly at exp', async () => {
    const { token, expiresIn } = await service.issue(user);
    expect(expiresIn).toBe(900);
    await expect(service.verify(token)).resolves.toEqual({
      userId: user.id,
      role: 'viewer',
      tokenId: '00000000-0000-7000-8000-000000000001',
    });
    clock.advance(900_000);
    await expect(service.verify(token)).rejects.toThrow('invalid or expired token');
  });

  it('rejects tokens with claims it does not trust', async () => {
    const other = new JwtAccessTokenService({
      secret: SECRET,
      ttlSeconds: 900,
      clock,
      ids: new SequentialIdGenerator(),
    });
    const { token } = await other.issue({ id: 'not-a-uuid', role: 'viewer' });
    await expect(service.verify(token)).rejects.toThrow('invalid or expired token');
  });
});

describe('Argon2PasswordHasher', () => {
  it('uses argon2id with the OWASP parameters and verifies correctly', async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(hash, 'wrong')).toBe(false);
    expect(await hasher.verify('not-a-phc-string', 'x')).toBe(false);
    await expect(hasher.verifyDummy('anything')).resolves.toBeUndefined();
    // The dummy hash is computed once and reused.
    expect(await hasher.warmUp()).toBe(await hasher.warmUp());
  });
});

describe('refresh token codec and fingerprints', () => {
  it('generates 256-bit tokens and stores only their SHA-256', () => {
    const { raw, hash } = refreshTokenCodec.generate();
    expect(refreshTokenCodec.isWellFormed(raw)).toBe(true);
    expect(hash).toHaveLength(32);
    expect(refreshTokenCodec.hash(raw).equals(hash)).toBe(true);
    expect(refreshTokenCodec.isWellFormed('x')).toBe(false);
    expect(refreshTokenCodec.generate().raw).not.toBe(raw);
  });

  it('fingerprints deterministically per key and never echoes the input', () => {
    const a = new HmacFingerprinter(SECRET);
    const b = new HmacFingerprinter(`${SECRET}-other`);
    expect(a.fingerprint('alice@spine.test')).toBe(a.fingerprint('alice@spine.test'));
    expect(a.fingerprint('alice@spine.test')).not.toBe(b.fingerprint('alice@spine.test'));
    expect(a.fingerprint('alice@spine.test')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('attempt counters', () => {
  it('counts within a fixed window and resets after it', async () => {
    const clock = new ManualClock();
    const counter = new MemoryAttemptCounter(clock, 2);
    expect(await counter.hit('a', 1000)).toEqual({ count: 1, resetInMs: 1000 });
    clock.advance(400);
    expect(await counter.hit('a', 1000)).toEqual({ count: 2, resetInMs: 600 });
    clock.advance(600);
    expect(await counter.hit('a', 1000)).toEqual({ count: 1, resetInMs: 1000 });
    // Capacity 2: a third key triggers a sweep instead of unbounded growth.
    await counter.hit('b', 1000);
    expect(await counter.hit('c', 1000)).toEqual({ count: 1, resetInMs: 1000 });
  });

  it('falls back to the in-memory counter when Redis fails', async () => {
    const onError = vi.fn();
    const fallback = new MemoryAttemptCounter(new ManualClock());
    const counter = new FallbackAttemptCounter(
      { hit: () => Promise.reject(new Error('ECONNREFUSED')) },
      fallback,
      onError,
    );
    expect(await counter.hit('k', 1000)).toEqual({ count: 1, resetInMs: 1000 });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('escapeLike', () => {
  it('makes LIKE wildcards literal', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});
