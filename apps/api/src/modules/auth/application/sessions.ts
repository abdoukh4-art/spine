import type { Logger } from '../../../platform/logger.js';
import type { Clock, IdGenerator } from '../../../platform/runtime.js';
import { decideThrottle, normalizeEmail } from '../domain/login-throttle.js';
import { refreshExpiry } from '../domain/refresh-rotation.js';
import {
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  TooManyAttemptsError,
} from './errors.js';
import type {
  AccessTokenService,
  AttemptCounter,
  AuditStore,
  AuditWrite,
  AuthMetrics,
  IdentifierFingerprinter,
  PasswordHasher,
  RefreshTokenCodec,
  RefreshTokenRepository,
  UserCredentials,
  UserRecord,
  UserRepository,
} from './ports.js';

/** Where a request came from; copied into audit entries. */
export interface RequestContext {
  ip: string;
  userAgent: string | undefined;
  requestId: string;
}

/** A successful login or refresh: what the HTTP layer returns and sets as a cookie. */
export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  /** Raw refresh token for the `spine_refresh` cookie. Never logged, never stored raw. */
  refreshToken: string;
  user: UserRecord;
}

/** Dependencies of {@link SessionService}. */
export interface SessionServiceDeps {
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  hasher: PasswordHasher;
  accessTokens: AccessTokenService;
  codec: RefreshTokenCodec;
  attempts: AttemptCounter;
  audit: AuditStore;
  metrics: AuthMetrics;
  fingerprints: IdentifierFingerprinter;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  refreshTtlSeconds: number;
  loginMaxPerMinute: number;
}

const LOGIN_WINDOW_MS = 60_000;

type LoginFailureReason = 'unknown_user' | 'bad_password' | 'disabled';

/**
 * Login, refresh and logout use cases (ADR-0016). The class owns the security-relevant
 * ordering: throttle BEFORE hashing (so throttled requests cost nothing), always run one
 * argon2 verification (so timing doesn't reveal whether the email exists), and answer
 * every failure with the same {@link InvalidCredentialsError}.
 */
export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  /** Authenticates email + password and starts a new refresh-token family. */
  async login(email: string, password: string, ctx: RequestContext): Promise<SessionTokens> {
    const normalized = normalizeEmail(email);
    await this.throttle(normalized, ctx);
    const user = await this.deps.users.findCredentialsByEmail(normalized);
    const failure = await this.checkCredentials(user, password);
    if (failure !== null || user === null) {
      this.deps.metrics.loginAttempt('failure');
      await this.safeAudit(this.loginFailedEntry(normalized, user, failure ?? 'unknown_user', ctx));
      throw new InvalidCredentialsError();
    }
    const now = this.deps.clock.now();
    await this.deps.users.recordLogin(user.id, now);
    const tokens = await this.startFamily(user, now);
    this.deps.metrics.loginAttempt('success');
    await this.safeAudit({
      occurredAt: now,
      actorId: user.id,
      actorType: 'user',
      action: 'auth.login_succeeded',
      targetType: 'users',
      targetId: user.id,
      requestId: ctx.requestId,
      ip: ctx.ip,
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
    });
    return { ...tokens, user: toRecord({ ...user, lastLoginAt: now }) };
  }

  /** Rotates a refresh token (ADR-0016): one use only; a reused token kills its family. */
  async refresh(rawToken: string | undefined, ctx: RequestContext): Promise<SessionTokens> {
    if (rawToken === undefined || !this.deps.codec.isWellFormed(rawToken)) {
      throw new InvalidRefreshTokenError();
    }
    const now = this.deps.clock.now();
    const successor = this.deps.codec.generate();
    const result = await this.deps.refreshTokens.rotate(
      this.deps.codec.hash(rawToken),
      {
        id: this.deps.ids.next(),
        hash: successor.hash,
        expiresAt: refreshExpiry(now, this.deps.refreshTtlSeconds),
      },
      now,
    );
    if (result.outcome === 'family_revoked' && result.reason === 'reuse_detected') {
      await this.onReuseDetected(result.userId, result.familyId, now, ctx);
    }
    if (result.outcome !== 'rotated') throw new InvalidRefreshTokenError();
    const user = await this.deps.users.findById(result.userId);
    if (user === null || user.disabled) throw new InvalidRefreshTokenError();
    const access = await this.deps.accessTokens.issue(user);
    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: successor.raw,
      user,
    };
  }

  /** Revokes the presented token's whole family. Idempotent; unknown tokens are ignored. */
  async logout(rawToken: string | undefined, ctx: RequestContext): Promise<void> {
    if (rawToken === undefined || !this.deps.codec.isWellFormed(rawToken)) return;
    const now = this.deps.clock.now();
    const owner = await this.deps.refreshTokens.revokeFamilyOf(this.deps.codec.hash(rawToken), now);
    if (owner === null) return;
    await this.safeAudit({
      occurredAt: now,
      actorId: owner.userId,
      actorType: 'user',
      action: 'auth.logout',
      targetType: 'users',
      targetId: owner.userId,
      requestId: ctx.requestId,
      ip: ctx.ip,
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
    });
  }

  private async throttle(normalizedEmail: string, ctx: RequestContext): Promise<void> {
    const [ip, username] = await Promise.all([
      this.deps.attempts.hit(`ip:${ctx.ip}`, LOGIN_WINDOW_MS),
      this.deps.attempts.hit(
        `user:${this.deps.fingerprints.fingerprint(normalizedEmail)}`,
        LOGIN_WINDOW_MS,
      ),
    ]);
    const decision = decideThrottle(
      [
        { dimension: 'ip', ...ip },
        { dimension: 'username', ...username },
      ],
      this.deps.loginMaxPerMinute,
    );
    if (decision.allowed) return;
    this.deps.metrics.loginAttempt('throttled');
    // Logged, not audited: a flood of throttled attempts would drown the audit trail,
    // and the metric is what alerting watches.
    this.deps.logger.warn(
      { requestId: ctx.requestId, exceeded: decision.exceeded },
      'login throttled',
    );
    throw new TooManyAttemptsError(decision.retryAfterSeconds);
  }

  /**
   * Returns why the credentials are bad, or null when they're good. Exactly ONE argon2
   * verification runs on every path, so all outcomes cost the same time.
   */
  private async checkCredentials(
    user: UserCredentials | null,
    password: string,
  ): Promise<LoginFailureReason | null> {
    if (user === null) {
      await this.deps.hasher.verifyDummy(password);
      return 'unknown_user';
    }
    const valid = await this.deps.hasher.verify(user.passwordHash, password);
    if (!valid) return 'bad_password';
    // Checked AFTER the hash so a disabled account is indistinguishable by timing too.
    return user.disabled ? 'disabled' : null;
  }

  private async startFamily(user: UserRecord, now: Date): Promise<Omit<SessionTokens, 'user'>> {
    const refresh = this.deps.codec.generate();
    await this.deps.refreshTokens.issue({
      id: this.deps.ids.next(),
      userId: user.id,
      familyId: this.deps.ids.next(),
      hash: refresh.hash,
      expiresAt: refreshExpiry(now, this.deps.refreshTtlSeconds),
    });
    const access = await this.deps.accessTokens.issue(user);
    return { accessToken: access.token, expiresIn: access.expiresIn, refreshToken: refresh.raw };
  }

  private loginFailedEntry(
    normalizedEmail: string,
    user: UserCredentials | null,
    reason: LoginFailureReason,
    ctx: RequestContext,
  ): AuditWrite {
    return {
      occurredAt: this.deps.clock.now(),
      actorId: null,
      actorType: 'anonymous',
      action: 'auth.login_failed',
      ...(user !== null ? { targetType: 'users', targetId: user.id } : {}),
      requestId: ctx.requestId,
      ip: ctx.ip,
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
      // The reason is for admins only; the client always gets "invalid credentials".
      details: { reason, emailFingerprint: this.deps.fingerprints.fingerprint(normalizedEmail) },
    };
  }

  private async onReuseDetected(
    userId: string,
    familyId: string,
    now: Date,
    ctx: RequestContext,
  ): Promise<void> {
    this.deps.metrics.refreshReuseDetected();
    this.deps.logger.warn(
      { userId, familyId, requestId: ctx.requestId },
      'refresh token reuse detected',
    );
    await this.safeAudit({
      occurredAt: now,
      actorId: null,
      actorType: 'anonymous',
      action: 'auth.refresh_token_reuse_detected',
      targetType: 'users',
      targetId: userId,
      requestId: ctx.requestId,
      ip: ctx.ip,
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
      details: { familyId },
    });
  }

  /** Audit writes never fail the request (ADR-0064); failures are logged loudly instead. */
  private async safeAudit(entry: AuditWrite): Promise<void> {
    try {
      await this.deps.audit.append(entry);
    } catch (err) {
      this.deps.logger.error({ err, action: entry.action }, 'audit write failed');
    }
  }
}

/** Strips the password hash: the only way a {@link UserCredentials} may leave this file. */
export function toRecord(user: UserCredentials): UserRecord {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}
