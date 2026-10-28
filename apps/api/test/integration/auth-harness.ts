import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import type { AuthMetrics, LoginOutcome } from '../../src/modules/auth/application/ports.js';
import { createAuthModule, type AuthModule } from '../../src/modules/auth/index.js';
import { OutboxEventPublisher } from '../../src/platform/events/outbox.js';
import { buildHttpServer } from '../../src/platform/http/server.js';
import type { PlatformDeps } from '../../src/platform/module.js';
import { systemClock, uuidV7Generator, type Clock } from '../../src/platform/runtime.js';
import { testConfig } from '../support/config.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';

/** Shared setup for the auth integration tests (auth-*.test.ts). */

export const ORIGIN = 'https://console.spine.test';
export const PASSWORD = 'correct horse battery staple';
export const API = '/api/v1';

/** Counts metric increments so tests can assert on them. */
export class RecordingMetrics implements AuthMetrics {
  readonly logins: Record<LoginOutcome, number> = { success: 0, failure: 0, throttled: 0 };
  reuse = 0;
  loginAttempt(outcome: LoginOutcome): void {
    this.logins[outcome] += 1;
  }
  refreshReuseDetected(): void {
    this.reuse += 1;
  }
}

export interface AuthHarness {
  t: TestDatabase;
  app: FastifyInstance;
  auth: AuthModule;
  metrics: RecordingMetrics;
  close(): Promise<void>;
}

/** Builds a real HTTP server with only the auth module, against an isolated schema. */
export async function startAuthHarness(
  options: { env?: Record<string, string>; redis?: Redis | null; clock?: Clock } = {},
): Promise<AuthHarness> {
  const t = await createTestDatabase();
  const config = testConfig({
    CORS_ALLOWED_ORIGINS: ORIGIN,
    AUTH_LOGIN_MAX_PER_MINUTE: '1000',
    ...options.env,
  });
  const clock = options.clock ?? systemClock;
  const deps: PlatformDeps = {
    config,
    logger: pino({ level: 'silent' }),
    db: t.db,
    clock,
    ids: uuidV7Generator,
    events: new OutboxEventPublisher(uuidV7Generator, clock),
    redis: options.redis ?? null,
  };
  const metrics = new RecordingMetrics();
  const auth = createAuthModule(deps, { metrics });
  const app = await buildHttpServer({
    config,
    modules: [auth.module],
    authenticator: auth.api.authenticator,
    redis: null,
    logger: false,
    readiness: () => Promise.resolve({ status: 'ready', checks: {} }),
  });
  return {
    t,
    app,
    auth,
    metrics,
    close: async () => {
      await app.close();
      await t.destroy();
    },
  };
}

/** Logs in and returns the parsed body plus the raw refresh cookie value. */
export async function login(
  app: FastifyInstance,
  email: string,
  password = PASSWORD,
  remoteAddress = '127.0.0.1',
): Promise<{ res: LightMyRequestResponse; accessToken: string; refresh: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { email, password },
    remoteAddress,
  });
  const cookie = res.cookies.find((c) => c.name === 'spine_refresh');
  const body = res.statusCode === 200 ? res.json<{ accessToken: string }>() : undefined;
  return { res, accessToken: body?.accessToken ?? '', refresh: cookie?.value ?? '' };
}

/** Calls a cookie endpoint (`refresh` / `logout`) the way the console does. */
export function cookieCall(
  app: FastifyInstance,
  path: 'refresh' | 'logout',
  refresh: string | undefined,
  headers: Record<string, string> = { 'x-spine-csrf': '1', origin: ORIGIN },
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `${API}/auth/${path}`,
    headers,
    ...(refresh !== undefined ? { cookies: { spine_refresh: refresh } } : {}),
  });
}

/** Bearer header helper. */
export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
