import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../../../src/composition.js';
import type { AccessPolicy } from '../../../src/platform/http/access.js';
import { buildHttpServer } from '../../../src/platform/http/server.js';
import type { SpineModule } from '../../../src/platform/module.js';
import { testConfig } from '../../support/config.js';

/**
 * RBAC matrix (ADR-0017, docs/security/rbac.md): builds the FULL application, records the
 * `config.access` of every route, and compares it with the documented matrix below.
 *
 * HOW TO EXTEND: when you add a route, add one line to EXPECTED (and to rbac.md). Routes are
 * listed here before their module implements them; the test only requires that every
 * REGISTERED route is listed with the right policy, and that every route marked
 * `implemented` is registered. Failures print a diff of "METHOD path → policy" lines.
 *
 * Platform routes registered before modules (`/healthz`, `/readyz`, `/api/v1/openapi.json`)
 * are covered by test/unit/platform/http.test.ts.
 */
type Policy = 'public' | 'webhook' | 'viewer' | 'analyst' | 'admin';

const V = '/api/v1';
const EXPECTED: Record<string, { policy: Policy; implemented?: true }> = {
  // auth (this module)
  [`POST ${V}/auth/login`]: { policy: 'public', implemented: true },
  [`POST ${V}/auth/refresh`]: { policy: 'public', implemented: true },
  [`POST ${V}/auth/logout`]: { policy: 'public', implemented: true },
  [`GET ${V}/auth/me`]: { policy: 'viewer', implemented: true },
  [`GET ${V}/users`]: { policy: 'admin', implemented: true },
  [`POST ${V}/users`]: { policy: 'admin', implemented: true },
  [`PATCH ${V}/users/:id`]: { policy: 'admin', implemented: true },
  [`GET ${V}/audit-log`]: { policy: 'admin', implemented: true },
  // alerts / cases
  [`GET ${V}/alerts`]: { policy: 'viewer' },
  [`GET ${V}/alerts/:id`]: { policy: 'viewer' },
  [`PATCH ${V}/alerts/:id`]: { policy: 'analyst' },
  [`GET ${V}/cases`]: { policy: 'viewer' },
  [`GET ${V}/cases/:id`]: { policy: 'viewer' },
  [`POST ${V}/cases`]: { policy: 'analyst' },
  [`PATCH ${V}/cases/:id`]: { policy: 'analyst' },
  // ingestion
  [`POST ${V}/alerts`]: { policy: 'analyst' },
  [`POST ${V}/ingest/batch`]: { policy: 'analyst' },
  [`POST ${V}/ingest/webhooks/:sourceId`]: { policy: 'webhook' },
  // enrichment / scoring
  [`POST ${V}/alerts/:id/enrich`]: { policy: 'analyst' },
  [`GET ${V}/enrichment/providers`]: { policy: 'viewer' },
  [`GET ${V}/scoring/ruleset`]: { policy: 'viewer' },
  [`POST ${V}/scoring/preview`]: { policy: 'analyst' },
  // playbooks
  [`GET ${V}/playbooks`]: { policy: 'viewer' },
  [`GET ${V}/playbooks/:id`]: { policy: 'viewer' },
  [`POST ${V}/playbooks/validate`]: { policy: 'analyst' },
  [`POST ${V}/playbooks`]: { policy: 'admin' },
  [`PATCH ${V}/playbooks/:id`]: { policy: 'admin' },
  [`POST ${V}/playbooks/:id/runs`]: { policy: 'analyst' },
  [`GET ${V}/runs`]: { policy: 'viewer' },
  [`GET ${V}/runs/:id`]: { policy: 'viewer' },
  [`POST ${V}/runs/:id/cancel`]: { policy: 'analyst' },
  [`GET ${V}/approvals`]: { policy: 'viewer' },
  [`POST ${V}/approvals/:id/decision`]: { policy: 'analyst' },
  [`GET ${V}/simulated-actions`]: { policy: 'viewer' },
  // metrics
  [`GET ${V}/metrics/summary`]: { policy: 'viewer' },
};

function policyName(access: AccessPolicy | undefined): Policy | 'MISSING' {
  if (access === undefined) return 'MISSING';
  return typeof access === 'string' ? access : access.role;
}

const registered = new Map<string, Policy | 'MISSING'>();
let app: FastifyInstance;

beforeAll(async () => {
  // Dummy URLs: building the server opens no connection (pg pools connect lazily).
  const config = testConfig({ DATABASE_URL: 'postgres://rbac:rbac@127.0.0.1:1/rbac' });
  const application = createApplication(config, { redis: null });
  // A spy module placed FIRST: its root onRoute hook sees every module route registered later.
  const spy: SpineModule = {
    name: 'rbac-spy',
    httpPlugins: (root) => {
      root.addHook('onRoute', (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const method of methods) {
          if (method === 'HEAD' || method === 'OPTIONS') continue; // auto-generated
          registered.set(`${method} ${route.url}`, policyName(route.config?.access));
        }
      });
    },
  };
  app = await buildHttpServer({
    config,
    modules: [spy, ...application.modules],
    authenticator: application.authenticator,
    redis: null,
    logger: false,
    readiness: () => Promise.resolve({ status: 'ready', checks: {} }),
  });
  await app.ready();
  await application.deps.db.destroy();
});
afterAll(() => app.close());

describe('RBAC matrix', () => {
  it('every registered route is documented with the expected policy', () => {
    const actual = [...registered].map(([route, policy]) => `${route} → ${policy}`).sort();
    const expected = [...registered.keys()]
      .map(
        (route) =>
          `${route} → ${EXPECTED[route]?.policy ?? 'UNDOCUMENTED (add it to EXPECTED and rbac.md)'}`,
      )
      .sort();
    expect(actual).toEqual(expected);
  });

  it('every route marked implemented is registered', () => {
    const missing = Object.entries(EXPECTED)
      .filter(([route, e]) => e.implemented === true && !registered.has(route))
      .map(([route]) => route);
    expect(missing).toEqual([]);
  });

  it('only auth, health and webhook-style routes are reachable without a role', () => {
    const open = [...registered]
      .filter(([, policy]) => policy === 'public' || policy === 'webhook')
      .map(([route]) => route)
      .sort();
    const allowedOpen = Object.entries(EXPECTED)
      .filter(([, e]) => e.policy === 'public' || e.policy === 'webhook')
      .map(([route]) => route);
    for (const route of open) expect(allowedOpen).toContain(route);
  });
});
