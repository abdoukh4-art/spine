import type { PlatformDeps, SpineModule } from '../../platform/module.js';
import { UserAuthenticator } from './application/authenticator.js';
import { bootstrapAdmin, seedUsers, type SeedUser } from './application/bootstrap.js';
import type { AttemptCounter, AuthMetrics, PasswordHasher } from './application/ports.js';
import { SessionService } from './application/sessions.js';
import { UserAdminService } from './application/users.js';
import { Argon2PasswordHasher } from './adapters/argon2-hasher.js';
import {
  FallbackAttemptCounter,
  MemoryAttemptCounter,
  RedisAttemptCounter,
} from './adapters/attempt-counters.js';
import { HmacFingerprinter, refreshTokenCodec } from './adapters/crypto.js';
import { registerAdminRoutes } from './adapters/http/admin-routes.js';
import { registerAuditHook } from './adapters/http/audit-hook.js';
import { registerSessionRoutes } from './adapters/http/session-routes.js';
import { JwtAccessTokenService } from './adapters/jwt-access-tokens.js';
import { createAuthMetrics } from './adapters/otel-metrics.js';
import { PostgresAuditStore } from './adapters/postgres-audit.js';
import { PostgresRefreshTokenRepository } from './adapters/postgres-refresh-tokens.js';
import { PostgresUserRepository } from './adapters/postgres-users.js';
import type { AuthPublicApi } from './public-api.js';

export type { SeedUser } from './application/bootstrap.js';

/** Test seams: swap infrastructure without touching the composition root. */
export interface AuthModuleOverrides {
  metrics?: AuthMetrics;
  hasher?: PasswordHasher;
  attempts?: AttemptCounter;
}

/** What the composition root (and CLI seeders) get from the auth module. */
export interface AuthModule {
  module: SpineModule;
  api: AuthPublicApi;
  /** Idempotently creates demo users such as `analyst@spine.test` (see docs/modules/auth.md). */
  seedUsers(users: readonly SeedUser[]): Promise<string[]>;
}

/** Redis-backed login throttle with an in-memory fallback; in-memory only without Redis. */
function createAttemptCounter(deps: PlatformDeps): AttemptCounter {
  const memory = new MemoryAttemptCounter(deps.clock);
  if (!deps.redis) return memory;
  return new FallbackAttemptCounter(new RedisAttemptCounter(deps.redis), memory, (err) =>
    deps.logger.error({ err }, 'login throttle store unavailable; using in-memory fallback'),
  );
}

/**
 * Auth module composition (ADR-0016, ADR-0017): wires the adapters (argon2, jose,
 * Postgres, Redis, OpenTelemetry) into the use cases and exposes routes, the audit hook,
 * the platform authenticator and the first-run bootstrap. See docs/modules/auth.md.
 */
export function createAuthModule(
  deps: PlatformDeps,
  overrides: AuthModuleOverrides = {},
): AuthModule {
  const { config, db, clock, ids, logger } = deps;
  const users = new PostgresUserRepository(db);
  const refreshTokens = new PostgresRefreshTokenRepository(db);
  const audit = new PostgresAuditStore(db);
  const hasher = overrides.hasher ?? new Argon2PasswordHasher();
  const accessTokens = new JwtAccessTokenService({
    secret: config.AUTH_JWT_SECRET,
    ttlSeconds: config.AUTH_ACCESS_TTL_SECONDS,
    clock,
    ids,
  });
  const authenticator = new UserAuthenticator({
    accessTokens,
    users,
    clock,
    cacheTtlMs: config.AUTH_USER_CACHE_TTL_SECONDS * 1000,
  });
  const attempts = overrides.attempts ?? createAttemptCounter(deps);
  const sessions = new SessionService({
    users,
    refreshTokens,
    hasher,
    accessTokens,
    codec: refreshTokenCodec,
    attempts,
    audit,
    metrics: overrides.metrics ?? createAuthMetrics(),
    fingerprints: new HmacFingerprinter(config.AUTH_JWT_SECRET),
    clock,
    ids,
    logger,
    refreshTtlSeconds: config.AUTH_REFRESH_TTL_SECONDS,
    loginMaxPerMinute: config.AUTH_LOGIN_MAX_PER_MINUTE,
  });
  const userAdmin = new UserAdminService({
    users,
    refreshTokens,
    hasher,
    clock,
    ids,
    onUserChanged: (id) => authenticator.invalidate(id),
  });
  const bootstrapDeps = { users, hasher, ids, logger };

  const module: SpineModule = {
    name: 'auth',
    httpPlugins: (app) => registerAuditHook(app, audit, clock),
    routes: async (app) => {
      await registerSessionRoutes(app, {
        sessions,
        users: userAdmin,
        allowedOrigins: config.CORS_ALLOWED_ORIGINS,
        cookieSecure: config.COOKIE_SECURE,
        refreshTtlSeconds: config.AUTH_REFRESH_TTL_SECONDS,
      });
      registerAdminRoutes(app, { users: userAdmin, audit });
    },
    startup: async () => {
      if (hasher instanceof Argon2PasswordHasher) await hasher.warmUp();
      await bootstrapAdmin(
        bootstrapDeps,
        config.BOOTSTRAP_ADMIN_EMAIL,
        config.BOOTSTRAP_ADMIN_PASSWORD,
      );
    },
  };

  return {
    module,
    api: {
      authenticator,
      audit: {
        record: (entry, executor) => audit.append({ ...entry, occurredAt: clock.now() }, executor),
      },
    },
    seedUsers: (list) => seedUsers(bootstrapDeps, list),
  };
}
