import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  OverloadedError,
  UnauthenticatedError,
} from '../../../src/platform/errors.js';
import type { Authenticator } from '../../../src/platform/http/access.js';
import { requireUser } from '../../../src/platform/http/access.js';
import { buildHttpServer, runReadinessChecks } from '../../../src/platform/http/server.js';
import type { SpineModule } from '../../../src/platform/module.js';
import { testConfig } from '../../support/config.js';

const tokens: Record<string, { id: string; role: 'viewer' | 'analyst' | 'admin' }> = {
  'viewer-token': { id: '00000000-0000-7000-8000-000000000001', role: 'viewer' },
  'analyst-token': { id: '00000000-0000-7000-8000-000000000002', role: 'analyst' },
};
const fakeAuthenticator: Authenticator = {
  authenticate: (token) => {
    const user = tokens[token];
    if (!user) return Promise.reject(new UnauthenticatedError('bad token'));
    return Promise.resolve({
      kind: 'user',
      id: user.id,
      role: user.role,
      email: `${user.role}@spine.test`,
    });
  },
};

const testModule: SpineModule = {
  name: 'test',
  routes: (api) => {
    const app = api.withTypeProvider<ZodTypeProvider>();
    app.get('/public', { config: { access: 'public' } }, () => ({ ok: true }));
    app.get('/analyst-only', { config: { access: { role: 'analyst' } } }, (req) => ({
      id: requireUser(req).id,
    }));
    app.post(
      '/echo',
      {
        config: { access: 'public' },
        schema: {
          body: z.object({ n: z.number().int() }),
          response: { 200: z.object({ n: z.number() }) },
        },
      },
      (req) => ({ n: req.body.n, secret: 'must not leak' }),
    );
    app.get('/errors/:kind', { config: { access: 'public' } }, (req) => {
      const kind = (req.params as { kind: string }).kind;
      if (kind === 'conflict') throw new ConflictError('already decided');
      if (kind === 'notfound') throw new NotFoundError('Alert', 'x');
      if (kind === 'overloaded') throw new OverloadedError('busy', 5);
      throw new Error('database password is hunter2');
    });
  },
};

let app: FastifyInstance | undefined;
async function build(modules: SpineModule[] = [testModule]): Promise<FastifyInstance> {
  app = await buildHttpServer({
    config: testConfig(),
    modules,
    authenticator: fakeAuthenticator,
    redis: null,
    logger: false,
    readiness: () => runReadinessChecks({ database: () => Promise.resolve(true) }),
  });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('HTTP platform', () => {
  it('serves liveness and readiness without auth', async () => {
    const server = await build();
    expect((await server.inject('/healthz')).json()).toEqual({ status: 'ok' });
    const ready = await server.inject('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('propagates a well-formed inbound request id and mints one otherwise', async () => {
    const server = await build();
    const res = await server.inject({
      url: '/api/v1/public',
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(res.headers['x-request-id']).toBe('req-12345678');
    const minted = await server.inject({
      url: '/api/v1/public',
      headers: { 'x-request-id': 'bad id!' },
    });
    expect(minted.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers', async () => {
    const res = await (await build()).inject('/api/v1/public');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('enforces authentication and roles', async () => {
    const server = await build();
    const anon = await server.inject('/api/v1/analyst-only');
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['content-type']).toContain('application/problem+json');
    expect(anon.json().type).toBe('https://spine.dev/problems/unauthenticated');

    const viewer = await server.inject({
      url: '/api/v1/analyst-only',
      headers: { authorization: 'Bearer viewer-token' },
    });
    expect(viewer.statusCode).toBe(403);

    const analyst = await server.inject({
      url: '/api/v1/analyst-only',
      headers: { authorization: 'Bearer analyst-token' },
    });
    expect(analyst.statusCode).toBe(200);
    expect(analyst.json()).toEqual({ id: tokens['analyst-token']!.id });

    const bad = await server.inject({
      url: '/api/v1/analyst-only',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('refuses to register a route without an access policy (deny by default)', async () => {
    const leaky: SpineModule = {
      name: 'leaky',
      routes: (api) => void api.get('/leak', () => 'oops'),
    };
    await expect(build([leaky])).rejects.toThrow(/must declare config.access/);
  });

  it('validates requests and strips undeclared response fields', async () => {
    const server = await build();
    const invalid = await server.inject({
      method: 'POST',
      url: '/api/v1/echo',
      payload: { n: 'x' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      type: 'https://spine.dev/problems/validation-error',
      status: 400,
    });
    expect(invalid.json().errors[0].path).toContain('body');

    const ok = await server.inject({ method: 'POST', url: '/api/v1/echo', payload: { n: 7 } });
    expect(ok.json()).toEqual({ n: 7 });
  });

  it('maps application errors to problem details without leaking internals', async () => {
    const server = await build();
    expect((await server.inject('/api/v1/errors/conflict')).statusCode).toBe(409);
    expect((await server.inject('/api/v1/errors/notfound')).statusCode).toBe(404);
    const overloaded = await server.inject('/api/v1/errors/overloaded');
    expect(overloaded.statusCode).toBe(503);
    expect(overloaded.headers['retry-after']).toBe('5');
    const internal = await server.inject('/api/v1/errors/boom');
    expect(internal.statusCode).toBe(500);
    expect(internal.body).not.toContain('hunter2');
    expect(internal.json().instance).toBe(internal.headers['x-request-id']);
  });

  it('returns problem details for unknown routes and malformed JSON', async () => {
    const server = await build();
    expect((await server.inject('/api/v1/nope')).json().status).toBe(404);
    const malformed = await server.inject({
      method: 'POST',
      url: '/api/v1/echo',
      payload: '{"n":',
      headers: { 'content-type': 'application/json' },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('allows CORS only for configured origins', async () => {
    const server = await build();
    const allowed = await server.inject({
      method: 'OPTIONS',
      url: '/api/v1/public',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await server.inject({
      method: 'OPTIONS',
      url: '/api/v1/public',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the OpenAPI document', async () => {
    const res = await (await build()).inject('/api/v1/openapi.json');
    expect(res.json().openapi).toBe('3.1.0');
  });
});

describe('runReadinessChecks', () => {
  it('fails checks that throw or time out', async () => {
    const result = await runReadinessChecks(
      {
        ok: () => Promise.resolve(true),
        throws: () => Promise.reject(new Error('x')),
        slow: () => new Promise((r) => setTimeout(() => r(true), 200)),
      },
      50,
    );
    expect(result).toEqual({
      status: 'not_ready',
      checks: { ok: 'ok', throws: 'fail', slow: 'fail' },
    });
  });
});
