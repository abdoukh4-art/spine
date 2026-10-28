import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { HealthSchema, ReadinessSchema, type Readiness } from '@spine/shared-schema';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { apiDocsEnabled, type Config } from '../config.js';
import { loggerOptions } from '../logger.js';
import type { SpineModule } from '../module.js';
import { registerAccessControl, type Authenticator } from './access.js';
import { registerProblemHandlers } from './problem.js';

export interface HttpServerOptions {
  config: Config;
  modules: readonly SpineModule[];
  authenticator: Authenticator;
  readiness: () => Promise<Readiness>;
  /** Redis for distributed rate limiting; in-memory store when null (tests, single node). */
  redis: Redis | null;
  /** Override the logger (tests pass `false` to silence it). */
  logger?: boolean;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
export const API_PREFIX = '/api/v1';

/**
 * Builds the Fastify server: security plugins, validation via Zod, problem-details errors,
 * health endpoints, OpenAPI, and every module's routes under `/api/v1`.
 */
export async function buildHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = Fastify({
    logger: options.logger === false ? false : loggerOptions(config),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    // Correlation ID: reuse a well-formed inbound X-Request-ID, otherwise mint one.
    requestIdHeader: false, // genReqId reads and validates the header itself
    genReqId: (req) => {
      const inbound = req.headers['x-request-id'];
      return typeof inbound === 'string' && REQUEST_ID_PATTERN.test(inbound)
        ? inbound
        : randomUUID();
    },
    return503OnClosing: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
  app.addContentTypeParser(
    ['application/x-ndjson', 'text/plain'],
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  registerProblemHandlers(app);
  await registerSecurity(app, options);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Spine API',
        version: '1.0.0',
        description:
          'Security Orchestration, Automation and Response — see docs/architecture/api-contract.md',
        license: { name: 'MIT' },
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
    // Emits schemas registered with an `id` (e.g. the recursive Condition) into components.
    transformObject: jsonSchemaTransformObject,
  });
  if (apiDocsEnabled(config)) {
    await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
  }

  // Deny-by-default (ADR-0017): from here on, refuse to register any route that does not
  // declare an access policy, so the server fails at startup instead of silently exposing
  // a route. Registered after third-party plugins (CORS preflight, Swagger UI) on purpose.
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/docs')) return;
    const config = route.config as { access?: unknown } | undefined;
    if (config?.access === undefined) {
      throw new Error(`Route ${route.method.toString()} ${route.url} must declare config.access`);
    }
  });
  registerAccessControl(app, options.authenticator);
  registerHealthRoutes(app, options.readiness);

  app.get(
    `${API_PREFIX}/openapi.json`,
    { config: { access: 'public' }, schema: { hide: true } },
    () => app.swagger(),
  );

  for (const module of options.modules) {
    if (module.httpPlugins) await module.httpPlugins(app);
  }

  await app.register(
    async (api) => {
      for (const module of options.modules) {
        if (module.routes) await module.routes(api);
      }
    },
    { prefix: API_PREFIX },
  );

  return app;
}

async function registerSecurity(app: FastifyInstance, options: HttpServerOptions): Promise<void> {
  const { config } = options;
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS is set by the TLS-terminating reverse proxy (infra/nginx), not by the app.
    hsts: false,
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin and non-browser requests have no Origin header.
      if (!origin || config.CORS_ALLOWED_ORIGINS.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'x-request-id',
      'x-spine-csrf',
    ],
    exposedHeaders: ['x-request-id', 'retry-after', 'idempotent-replay'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX_PER_MINUTE,
    timeWindow: '1 minute',
    ...(options.redis ? { redis: options.redis, nameSpace: 'spine-rl:' } : {}),
    // Health probes must never be rate limited (orchestrators poll them).
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      message: `Rate limit exceeded, retry in ${context.after}`,
    }),
  });
}

function registerHealthRoutes(app: FastifyInstance, readiness: () => Promise<Readiness>): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/healthz',
    {
      config: { access: 'public', rateLimit: false },
      schema: { tags: ['platform'], summary: 'Liveness probe', response: { 200: HealthSchema } },
    },
    () => ({ status: 'ok' as const }),
  );
  typed.get(
    '/readyz',
    {
      config: { access: 'public', rateLimit: false },
      schema: {
        tags: ['platform'],
        summary: 'Readiness probe',
        response: { 200: ReadinessSchema, 503: ReadinessSchema },
      },
    },
    async (_req, reply) => {
      const result = await readiness();
      return reply.status(result.status === 'ready' ? 200 : 503).send(result);
    },
  );
}

/** Runs named boolean checks concurrently, each with a timeout, into a {@link Readiness}. */
export async function runReadinessChecks(
  checks: Record<string, () => Promise<boolean>>,
  timeoutMs = 2000,
): Promise<Readiness> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const ok = await Promise.race([check().catch(() => false), timeout]);
      clearTimeout(timer);
      return [name, ok ? 'ok' : 'fail'] as const;
    }),
  );
  const checksResult = Object.fromEntries(entries);
  const status = entries.every(([, v]) => v === 'ok') ? 'ready' : 'not_ready';
  return { status, checks: checksResult };
}
