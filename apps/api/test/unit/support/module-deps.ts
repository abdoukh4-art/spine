import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { createDatabase } from '../../../src/platform/db/database.js';
import { RecordingEventPublisher } from '../../../src/platform/events/in-memory.js';
import type { Authenticator } from '../../../src/platform/http/access.js';
import { UnauthenticatedError } from '../../../src/platform/errors.js';
import { buildHttpServer, runReadinessChecks } from '../../../src/platform/http/server.js';
import type { PlatformDeps, SpineModule } from '../../../src/platform/module.js';
import { ManualClock, SequentialIdGenerator } from '../../../src/platform/runtime.js';
import { testConfig } from '../../support/config.js';

/**
 * Platform deps for route/unit tests that never touch the database: the pg pool connects
 * lazily, so pointing it at a closed port is harmless as long as no query runs.
 */
export function unitDeps(overrides: Record<string, string> = {}): PlatformDeps & {
  events: RecordingEventPublisher;
} {
  const config = testConfig(overrides);
  return {
    config,
    logger: pino({ level: 'silent' }),
    db: createDatabase({ connectionString: 'postgres://unit:unit@127.0.0.1:1/unit' }),
    clock: new ManualClock('2026-10-28T10:00:00Z'),
    ids: new SequentialIdGenerator(),
    events: new RecordingEventPublisher(),
    redis: null,
  };
}

const roles = { viewer: 'viewer', analyst: 'analyst', admin: 'admin' } as const;

/** Accepts `Bearer viewer|analyst|admin` and nothing else. */
export const roleTokenAuthenticator: Authenticator = {
  authenticate: (token) => {
    const role = roles[token as keyof typeof roles] as
      | (typeof roles)[keyof typeof roles]
      | undefined;
    if (!role) return Promise.reject(new UnauthenticatedError('bad token'));
    return Promise.resolve({
      kind: 'user',
      id: '00000000-0000-7000-8000-0000000000c1',
      role,
      email: `${role}@spine.test`,
    });
  },
};

/** Builds the real HTTP server around the given modules, with {@link roleTokenAuthenticator}. */
export function buildTestServer(modules: SpineModule[]): Promise<FastifyInstance> {
  return buildHttpServer({
    config: testConfig(),
    modules,
    authenticator: roleTokenAuthenticator,
    redis: null,
    logger: false,
    readiness: () => runReadinessChecks({}),
  });
}

/** `authorization` header for a role. */
export const as = (role: keyof typeof roles) => ({ authorization: `Bearer ${role}` });
