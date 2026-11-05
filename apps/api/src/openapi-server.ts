import type { FastifyInstance } from 'fastify';
import { createApplication } from './composition.js';
import { loadConfig } from './platform/config.js';
import { buildHttpServer } from './platform/http/server.js';

/**
 * Builds the HTTP server with dummy infrastructure, only to introspect routes and
 * generate the OpenAPI document. No connections are opened (pg pools connect lazily).
 */
export async function buildOpenApiServer(): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://openapi:openapi@127.0.0.1:1/openapi',
    REDIS_URL: 'redis://127.0.0.1:1',
    AUTH_JWT_SECRET: 'openapi-generation-only-secret-0123456789',
    ENABLE_API_DOCS: 'false',
  });
  const app = createApplication(config, { redis: null });
  return buildHttpServer({
    config,
    modules: app.modules,
    authenticator: app.authenticator,
    redis: null,
    logger: false,
    readiness: () => Promise.resolve({ status: 'ready', checks: {} }),
  });
}
