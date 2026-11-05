import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ManualClock, SequentialIdGenerator } from '../../../platform/runtime.js';
import { MemoryAttemptCounter } from '../adapters/attempt-counters.js';
import { UserAuthenticator } from './authenticator.js';
import { InvalidCredentialsError, TooManyAttemptsError } from './errors.js';
import type {
  AccessTokenService,
  AuditStore,
  PasswordHasher,
  RefreshTokenRepository,
  UserCredentials,
  UserRepository,
} from './ports.js';
import { SessionService } from './sessions.js';

/**
 * Unit tests of the session use cases with in-memory fakes: they pin down the ORDER of
 * security-relevant steps, which integration tests can't observe directly.
 */
const alice: UserCredentials = {
  id: '00000000-0000-7000-8000-00000000a11c',
  email: 'alice@spine.test',
  displayName: 'Alice',
  role: 'analyst',
  disabled: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  lastLoginAt: null,
  passwordHash: 'stored-hash',
};

function setup(user: UserCredentials | null, options: { max?: number; failAudit?: boolean } = {}) {
  const clock = new ManualClock('2026-10-28T10:00:00Z');
  const hasher = {
    hash: vi.fn(() => Promise.resolve('h')),
    verify: vi.fn((_h: string, pw: string) => Promise.resolve(pw === 'right password!')),
    verifyDummy: vi.fn(() => Promise.resolve()),
  } satisfies PasswordHasher;
  const users = {
    findCredentialsByEmail: vi.fn(() => Promise.resolve(user)),
    findById: vi.fn(() => Promise.resolve(user)),
    recordLogin: vi.fn(() => Promise.resolve()),
  } as unknown as UserRepository;
  const audit = {
    append: vi.fn(() =>
      options.failAudit === true ? Promise.reject(new Error('db down')) : Promise.resolve(),
    ),
    query: vi.fn(),
  } as unknown as AuditStore;
  const refreshTokens = {
    issue: vi.fn(() => Promise.resolve()),
  } as unknown as RefreshTokenRepository;
  const accessTokens: AccessTokenService = {
    issue: () => Promise.resolve({ token: 'jwt', expiresIn: 900 }),
    verify: () => Promise.resolve({ userId: alice.id, role: 'analyst', tokenId: 't' }),
  };
  const metrics = { loginAttempt: vi.fn(), refreshReuseDetected: vi.fn() };
  const service = new SessionService({
    users,
    refreshTokens,
    hasher,
    accessTokens,
    codec: {
      generate: () => ({ raw: 'r'.repeat(43), hash: Buffer.from('h') }),
      hash: () => Buffer.from('h'),
      isWellFormed: () => true,
    },
    attempts: new MemoryAttemptCounter(clock),
    audit,
    metrics,
    fingerprints: { fingerprint: (e) => `fp(${e})` },
    clock,
    ids: new SequentialIdGenerator(),
    logger: pino({ level: 'silent' }),
    refreshTtlSeconds: 3600,
    loginMaxPerMinute: options.max ?? 10,
  });
  return { service, hasher, users, audit, metrics, clock };
}

const ctx = { ip: '10.0.0.1', userAgent: 'ua', requestId: 'req-1' };

describe('SessionService.login', () => {
  it('runs exactly one dummy verification for an unknown email (no enumeration by timing)', async () => {
    const { service, hasher } = setup(null);
    await expect(service.login('ghost@spine.test', 'whatever', ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(hasher.verifyDummy).toHaveBeenCalledTimes(1);
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it('verifies the password BEFORE revealing that the account is disabled', async () => {
    const { service, hasher, audit } = setup({ ...alice, disabled: true });
    await expect(service.login(alice.email, 'right password!', ctx)).rejects.toThrow(
      'invalid credentials',
    );
    expect(hasher.verify).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login_failed',
        details: { reason: 'disabled', emailFingerprint: 'fp(alice@spine.test)' },
      }),
    );
  });

  it('throttles before any database or hashing work', async () => {
    const { service, hasher, users, metrics } = setup(alice, { max: 2 });
    await service.login(alice.email, 'right password!', ctx);
    await service.login(alice.email, 'right password!', ctx);
    const error = await service.login(alice.email, 'right password!', ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TooManyAttemptsError);
    expect((error as TooManyAttemptsError).retryAfterSeconds).toBe(60);
    expect(hasher.verify).toHaveBeenCalledTimes(2);
    expect(users.findCredentialsByEmail).toHaveBeenCalledTimes(2);
    expect(metrics.loginAttempt).toHaveBeenLastCalledWith('throttled');
  });

  it('opens a new window after a minute', async () => {
    const { service, clock } = setup(alice, { max: 1 });
    await service.login(alice.email, 'right password!', ctx);
    await expect(service.login(alice.email, 'right password!', ctx)).rejects.toBeInstanceOf(
      TooManyAttemptsError,
    );
    clock.advance(60_000);
    await expect(service.login(alice.email, 'right password!', ctx)).resolves.toMatchObject({
      accessToken: 'jwt',
    });
  });

  it('still logs the user in when the audit write fails (ADR-0064)', async () => {
    const { service } = setup(alice, { failAudit: true });
    await expect(service.login(alice.email, 'right password!', ctx)).resolves.toMatchObject({
      user: { id: alice.id },
    });
  });
});

describe('UserAuthenticator cache', () => {
  it('reuses a loaded user for the TTL, then reloads it', async () => {
    const clock = new ManualClock();
    const findById = vi.fn(() => Promise.resolve<UserCredentials>(alice));
    const authenticator = new UserAuthenticator({
      accessTokens: {
        issue: vi.fn(),
        verify: () => Promise.resolve({ userId: alice.id, role: 'admin', tokenId: 't' }),
      },
      users: { findById } as unknown as UserRepository,
      clock,
      cacheTtlMs: 30_000,
      maxEntries: 1,
    });
    const principal = await authenticator.authenticate('jwt');
    // The DB role (analyst) wins over the token claim (admin).
    expect(principal).toEqual({ kind: 'user', id: alice.id, role: 'analyst', email: alice.email });
    await authenticator.authenticate('jwt');
    expect(findById).toHaveBeenCalledTimes(1);
    clock.advance(30_001);
    await authenticator.authenticate('jwt');
    expect(findById).toHaveBeenCalledTimes(2);
    authenticator.invalidate(alice.id);
    await authenticator.authenticate('jwt');
    expect(findById).toHaveBeenCalledTimes(3);
  });

  it('rejects disabled and deleted users', async () => {
    const make = (user: UserCredentials | null) =>
      new UserAuthenticator({
        accessTokens: {
          issue: vi.fn(),
          verify: () => Promise.resolve({ userId: alice.id, role: 'admin', tokenId: 't' }),
        },
        users: { findById: () => Promise.resolve(user) } as unknown as UserRepository,
        clock: new ManualClock(),
        cacheTtlMs: 0,
      });
    await expect(make({ ...alice, disabled: true }).authenticate('jwt')).rejects.toThrow(
      'invalid or expired token',
    );
    await expect(make(null).authenticate('jwt')).rejects.toThrow('invalid or expired token');
  });
});
