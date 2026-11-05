/**
 * Contract tests (ADR-0005, ADR-0021): REAL responses from the fully composed application are
 * validated against the COMMITTED OpenAPI document (docs/architecture/openapi.json), the one
 * integrators and the console rely on. CI's `contract` job separately guarantees that this
 * file is regenerated from the code, so together they prove: code ⇄ spec ⇄ behaviour.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication, type Application } from '../../src/composition.js';
import { InlineDeliveryQueue } from '../../src/platform/events/in-memory.js';
import { OutboxRelay } from '../../src/platform/events/outbox.js';
import { buildHttpServer, runReadinessChecks } from '../../src/platform/http/server.js';
import { testConfig } from '../support/config.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';

const spec = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../../docs/architecture/openapi.json'),
    'utf8',
  ),
) as { paths: Record<string, Record<string, { responses?: Record<string, unknown> }>> };

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
ajv.addSchema(spec, 'openapi');

/** JSON-pointer escape for a path segment (RFC 6901). */
const esc = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');

/** Validates `body` against the documented response schema for (path, method, status). */
function expectMatchesSpec(
  specPath: string,
  method: string,
  status: number,
  body: unknown,
  contentType = 'application/json',
): void {
  const op = spec.paths[specPath]?.[method];
  expect(op, `${method.toUpperCase()} ${specPath} is not in openapi.json`).toBeDefined();
  expect(
    op?.responses?.[String(status)],
    `${method.toUpperCase()} ${specPath} does not document ${status}`,
  ).toBeDefined();
  const pointer = `openapi#/paths/${esc(specPath)}/${method}/responses/${status}/content/${esc(contentType)}/schema`;
  const validate = ajv.getSchema(pointer);
  expect(validate, `no schema at ${pointer}`).toBeDefined();
  const ok = validate?.(body);
  expect(ok, JSON.stringify(validate?.errors?.slice(0, 5), null, 2)).toBe(true);
}

const ADMIN = { email: 'contract-admin@spine.test', password: 'contract-test-passphrase-1' };
let t: TestDatabase;
let app: Application;
let server: FastifyInstance;
let relay: OutboxRelay;
let headers: Record<string, string>;

beforeAll(async () => {
  t = await createTestDatabase();
  const config = testConfig({
    BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
    ENRICHMENT_LATENCY_MS: '0',
    SIMULATION_LATENCY_MS: '0',
  });
  const logger = pino({ level: 'silent' });
  app = createApplication(config, { db: t.db, redis: null, logger });
  for (const m of app.modules) await m.startup?.();
  server = await buildHttpServer({
    config,
    modules: app.modules,
    authenticator: app.authenticator,
    redis: null,
    logger: false,
    readiness: () => runReadinessChecks(app.readinessChecks),
  });
  // Run the event pipeline in-process (no Redis): enrichment → scoring → projections → triggers.
  relay = new OutboxRelay(
    t.db,
    app.subscriptions,
    new InlineDeliveryQueue(app.subscriptions, logger),
    logger,
    {
      pollIntervalMs: 10,
      batchSize: 100,
    },
  );
  // Seed playbooks (normally a worker background task) without starting queue workers.
  for (const task of app.modules
    .flatMap((m) => m.backgroundTasks?.() ?? [])
    .filter((k) => /seed/i.test(k.name))) {
    await task.start();
  }
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ADMIN });
  expect(login.statusCode, login.body).toBe(200);
  expectMatchesSpec('/api/v1/auth/login', 'post', 200, login.json());
  headers = { authorization: `Bearer ${login.json().accessToken}` };
});

afterAll(async () => {
  await server.close();
  await t.destroy();
});

async function drainPipeline(): Promise<void> {
  for (let i = 0; i < 20 && (await relay.dispatchBatch()) > 0; i++);
}

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const res = await server.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json(), raw: res.body };
}

describe('API responses match the committed OpenAPI document', () => {
  let alertId = '';
  let caseId = '';
  let runId = '';

  it('platform and auth', async () => {
    const health = await server.inject('/healthz');
    expectMatchesSpec('/healthz', 'get', 200, health.json());
    const ready = await server.inject('/readyz');
    expectMatchesSpec('/readyz', 'get', ready.statusCode, ready.json());
    const me = await call('GET', '/api/v1/auth/me');
    expectMatchesSpec('/api/v1/auth/me', 'get', me.status, me.body);
    const users = await call('GET', '/api/v1/users');
    expectMatchesSpec('/api/v1/users', 'get', users.status, users.body);
  });

  it('ingestion and alerts', async () => {
    const ingest = await call('POST', '/api/v1/alerts', {
      source: { vendor: 'Acme', product: 'EDR', sourceAlertId: 'contract-1' },
      title: 'Contract test: beacon on fin-db01',
      category: 'malware',
      severity: 'high',
      occurredAt: '2026-10-28T10:00:00.000Z',
      host: { hostname: 'fin-db01.corp.example', ips: ['10.20.5.20'] },
      network: { destinationIp: '203.0.113.66' },
    });
    expectMatchesSpec('/api/v1/alerts', 'post', ingest.status, ingest.body);
    alertId = (ingest.body as { alertId: string }).alertId;
    await drainPipeline();

    const list = await call('GET', '/api/v1/alerts?sort=score&limit=10');
    expectMatchesSpec('/api/v1/alerts', 'get', list.status, list.body);
    const detail = await call('GET', `/api/v1/alerts/${alertId}`);
    expectMatchesSpec('/api/v1/alerts/{id}', 'get', detail.status, detail.body);
    expect((detail.body as { score: unknown }).score).not.toBeNull();
    const patched = await call('PATCH', `/api/v1/alerts/${alertId}`, { status: 'triaged' });
    expectMatchesSpec('/api/v1/alerts/{id}', 'patch', patched.status, patched.body);
  });

  it('cases', async () => {
    const created = await call('POST', '/api/v1/cases', {
      title: 'Contract case',
      alertIds: [alertId],
    });
    expectMatchesSpec('/api/v1/cases', 'post', created.status, created.body);
    caseId = (created.body as { id: string }).id;
    const list = await call('GET', '/api/v1/cases');
    expectMatchesSpec('/api/v1/cases', 'get', list.status, list.body);
    const one = await call('GET', `/api/v1/cases/${caseId}`);
    expectMatchesSpec('/api/v1/cases/{id}', 'get', one.status, one.body);
  });

  it('enrichment and scoring', async () => {
    const providers = await call('GET', '/api/v1/enrichment/providers');
    expectMatchesSpec('/api/v1/enrichment/providers', 'get', providers.status, providers.body);
    const ruleset = await call('GET', '/api/v1/scoring/ruleset');
    expectMatchesSpec('/api/v1/scoring/ruleset', 'get', ruleset.status, ruleset.body);
  });

  it('playbooks, runs, approvals and simulated actions', async () => {
    const playbooks = await call('GET', '/api/v1/playbooks');
    expectMatchesSpec('/api/v1/playbooks', 'get', playbooks.status, playbooks.body);
    const one = await call('GET', '/api/v1/playbooks/malware-containment');
    expectMatchesSpec('/api/v1/playbooks/{id}', 'get', one.status, one.body);
    const manual = await call('POST', '/api/v1/playbooks/phishing-triage/runs', {
      alertId,
      dryRun: true,
    });
    expectMatchesSpec('/api/v1/playbooks/{id}/runs', 'post', manual.status, manual.body);
    runId = (manual.body as { runId: string }).runId;
    const runs = await call('GET', '/api/v1/runs');
    expectMatchesSpec('/api/v1/runs', 'get', runs.status, runs.body);
    const run = await call('GET', `/api/v1/runs/${runId}`);
    expectMatchesSpec('/api/v1/runs/{id}', 'get', run.status, run.body);
    const approvals = await call('GET', '/api/v1/approvals');
    expectMatchesSpec('/api/v1/approvals', 'get', approvals.status, approvals.body);
    const actions = await call('GET', '/api/v1/simulated-actions');
    expectMatchesSpec('/api/v1/simulated-actions', 'get', actions.status, actions.body);
  });

  it('metrics and audit log', async () => {
    const metrics = await call('GET', '/api/v1/metrics/summary');
    expectMatchesSpec('/api/v1/metrics/summary', 'get', metrics.status, metrics.body);
    const audit = await call('GET', '/api/v1/audit-log');
    expectMatchesSpec('/api/v1/audit-log', 'get', audit.status, audit.body);
  });

  it('documented error responses are problem details', async () => {
    const missing = await call('GET', '/api/v1/runs/00000000-0000-7000-8000-000000000000');
    expect(missing.status).toBe(404);
    expectMatchesSpec('/api/v1/runs/{id}', 'get', 404, missing.body, 'application/problem+json');
  });
});
