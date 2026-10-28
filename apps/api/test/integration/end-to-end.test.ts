/* eslint-disable @typescript-eslint/no-unsafe-call -- inject().json() is typed any; asserting on it is the point */
/**
 * End-to-end pipeline through the REAL composition root and REAL worker machinery
 * (transactional outbox → relay → BullMQ → subscribers → playbook executor):
 *
 *   POST /alerts ─▶ alert.ingested ─▶ enrichment ─▶ alert.enriched ─▶ scoring ─▶ alert.scored
 *        ─▶ alerts projection (score on the queue) + playbook trigger ─▶ run ─▶ approval gate
 *        ─▶ analyst approves ─▶ simulated block + ticket + notify ─▶ run.succeeded ─▶ metrics
 *
 * This is the test that proves the modules built in parallel actually work together.
 */
import type { FastifyInstance } from 'fastify';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication, type Application } from '../../src/composition.js';
import { UnauthenticatedError } from '../../src/platform/errors.js';
import { OutboxRelay } from '../../src/platform/events/outbox.js';
import type { Authenticator } from '../../src/platform/http/access.js';
import { buildHttpServer, runReadinessChecks } from '../../src/platform/http/server.js';
import type { BackgroundTask } from '../../src/platform/module.js';
import { BullMqDeliveryQueue, createRedis, startEventWorker } from '../../src/platform/queue/bullmq.js';
import { testConfig } from '../support/config.js';
import { createTestDatabase, testRedisUrl, type TestDatabase } from '../support/db.js';

const ANALYST = { id: '00000000-0000-7000-8000-0000000e2e01', role: 'analyst' as const };
const authenticator: Authenticator = {
  authenticate: (token) =>
    token === 'analyst'
      ? Promise.resolve({ kind: 'user', ...ANALYST, email: 'analyst@spine.test' })
      : Promise.reject(new UnauthenticatedError('bad token')),
};
const headers = { authorization: 'Bearer analyst' };
const logger = pino({ level: 'silent' });

let t: TestDatabase;
let redis: Redis;
let app: Application;
let server: FastifyInstance;
let relay: OutboxRelay;
let deliveryQueue: BullMqDeliveryQueue;
let eventWorker: Worker;
let tasks: BackgroundTask[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  // A dedicated Redis database: BullMQ queue names are global, and other test files use db 0.
  redis = createRedis(`${testRedisUrl()}/11`);
  await redis.flushdb();
  const config = testConfig({
    SIMULATION_LATENCY_MS: '0',
    ENRICHMENT_LATENCY_MS: '0',
    OUTBOX_POLL_INTERVAL_MS: '20',
  });
  app = createApplication(config, { db: t.db, redis, logger });
  server = await buildHttpServer({
    config,
    modules: app.modules,
    authenticator,
    redis: null,
    logger: false,
    readiness: () => runReadinessChecks(app.readinessChecks),
  });
  // The worker process, in-process: relay + event worker + module background tasks.
  deliveryQueue = new BullMqDeliveryQueue(redis);
  relay = new OutboxRelay(t.db, app.subscriptions, deliveryQueue, logger, { pollIntervalMs: 20, batchSize: 100 });
  eventWorker = startEventWorker({ connection: redis, subscriptions: app.subscriptions, logger, concurrency: 4 });
  tasks = app.modules.flatMap((m) => m.backgroundTasks?.() ?? []);
  for (const task of tasks) await task.start();
  relay.start();
});

afterAll(async () => {
  await relay.stop();
  for (const task of [...tasks].reverse()) await task.stop();
  await eventWorker.close();
  await deliveryQueue.close();
  await server.close();
  await redis.flushdb();
  await redis.quit();
  await t.destroy();
});

async function get<T = any>(url: string): Promise<T> {
  const res = await server.inject({ url, headers });
  expect(res.statusCode, `${url} → ${res.body}`).toBe(200);
  return res.json() as T;
}

describe('end-to-end: alert to response', () => {
  it('ingests, enriches, scores, triggers a playbook, waits for approval and contains', async () => {
    // 1. A malware alert on a critical finance database server talking to a known C2 address.
    const ingest = await server.inject({
      method: 'POST',
      url: '/api/v1/alerts',
      headers: { ...headers, 'idempotency-key': 'e2e-malware-1' },
      payload: {
        source: { vendor: 'Acme', product: 'EDR', sourceAlertId: 'e2e-1' },
        title: 'Cobalt Strike beacon and LSASS access on fin-db01',
        category: 'malware',
        severity: 'high',
        occurredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        host: { hostname: 'fin-db01.corp.example', ips: ['10.20.5.20'] },
        network: { sourceIp: '10.20.5.20', destinationIp: '203.0.113.66', destinationPort: 443, protocol: 'tcp' },
        file: { name: 'beacon.exe', sha256: '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f' },
        mitre: [{ tacticId: 'TA0006', techniqueId: 'T1003.001' }, { tacticId: 'TA0011', techniqueId: 'T1071.001' }],
      },
    });
    expect(ingest.statusCode, ingest.body).toBe(202);
    const { alertId } = ingest.json() as { alertId: string };

    // 2. Enrichment → scoring → projection: the queue shows a score with an explanation.
    await expect
      .poll(async () => (await get(`/api/v1/alerts/${alertId}`)).score?.score ?? null, { timeout: 20_000, interval: 100 })
      .toBeGreaterThanOrEqual(80);
    const detail = await get(`/api/v1/alerts/${alertId}`);
    expect(detail.summary.score).toBe(detail.score.score);
    expect(detail.enrichments.some((e: { verdict?: string }) => e.verdict === 'malicious')).toBe(true);
    expect(detail.score.factors.length).toBeGreaterThan(1);

    // 3. The malware-containment playbook triggered and is waiting for an analyst.
    const approval = await expect
      .poll(
        async () =>
          (await get('/api/v1/approvals?status=pending')).items.find((a: { alertId: string }) => a.alertId === alertId) ?? null,
        { timeout: 20_000, interval: 100 },
      )
      .toBeTruthy()
      .then(async () => (await get('/api/v1/approvals?status=pending')).items.find((a: { alertId: string }) => a.alertId === alertId));
    expect(approval.playbookId).toBe('malware-containment');

    // 4. The analyst approves; the run blocks, opens a ticket, notifies and succeeds.
    const decision = await server.inject({
      method: 'POST',
      url: `/api/v1/approvals/${approval.id}/decision`,
      headers,
      payload: { decision: 'approve', comment: 'e2e: contain' },
    });
    expect(decision.statusCode, decision.body).toBe(200);
    await expect
      .poll(async () => (await get(`/api/v1/runs/${approval.runId}`)).status, { timeout: 20_000, interval: 100 })
      .toBe('succeeded');

    const actions = await get('/api/v1/simulated-actions?limit=50');
    const kinds = actions.items.filter((a: { runId: string }) => a.runId === approval.runId).map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['firewall.block', 'ticket.create', 'chat.post']));

    // 5. The run is visible on the alert, and the metrics see the alert.
    expect((await get(`/api/v1/alerts/${alertId}`)).runs.map((r: { id: string }) => r.id)).toContain(approval.runId);
    const metrics = await get('/api/v1/metrics/summary');
    expect(metrics.alertVolume.total).toBeGreaterThanOrEqual(1);
    expect(metrics.mttd.count).toBeGreaterThanOrEqual(1);
    expect(metrics.playbooks.runs.succeeded).toBeGreaterThanOrEqual(1);
  });

  it('closing the alert feeds MTTR', async () => {
    const page = await get('/api/v1/alerts?limit=1');
    const id = page.items[0].id as string;
    const res = await server.inject({ method: 'PATCH', url: `/api/v1/alerts/${id}`, headers, payload: { status: 'resolved' } });
    expect(res.statusCode, res.body).toBe(200);
    const metrics = await get('/api/v1/metrics/summary');
    expect(metrics.mttr.count).toBeGreaterThanOrEqual(1);
  });
});
