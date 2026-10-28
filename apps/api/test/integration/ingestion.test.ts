/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- inject().json() is typed any; asserting on it is the point (as in eslint.config.js) */
import type { CanonicalAlertInput } from '@spine/shared-schema';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication, type Application } from '../../src/composition.js';
import { createAlertsModule } from '../../src/modules/alerts/index.js';
import { OpenAlertExistsError, type AlertsPublicApi } from '../../src/modules/alerts/public-api.js';
import { createIngestionModule } from '../../src/modules/ingestion/index.js';
import { cefLines, suricataEveLines } from '../../src/modules/ingestion/fixtures/index.js';
import { signWebhook } from '../../src/modules/ingestion/domain/webhook-signature.js';
import { idempotencyCleanupTask } from '../../src/modules/ingestion/application/idempotency-cleanup.js';
import { PostgresIdempotencyStore } from '../../src/modules/ingestion/adapters/postgres/idempotency-store.js';
import { UnauthenticatedError } from '../../src/platform/errors.js';
import type { Authenticator } from '../../src/platform/http/access.js';
import { buildHttpServer, runReadinessChecks } from '../../src/platform/http/server.js';
import { ManualClock } from '../../src/platform/runtime.js';
import { testConfig } from '../support/config.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';

const SURICATA_SECRET = 'test-only-webhook-secret-suricata-000000001';
const CEF_SECRET = 'test-only-webhook-secret-cef-0000000000000001';
const ANALYST = { id: '00000000-0000-7000-8000-00000000a001', role: 'analyst' as const };
const OTHER_ANALYST = { id: '00000000-0000-7000-8000-00000000a002', role: 'analyst' as const };
const VIEWER = { id: '00000000-0000-7000-8000-00000000a003', role: 'viewer' as const };
const users: Record<string, { id: string; role: 'viewer' | 'analyst' | 'admin' }> = {
  analyst: ANALYST,
  other: OTHER_ANALYST,
  viewer: VIEWER,
};
const authenticator: Authenticator = {
  authenticate: (token) => {
    const u = users[token];
    return u
      ? Promise.resolve({ kind: 'user', id: u.id, role: u.role, email: `${token}@spine.test` })
      : Promise.reject(new UnauthenticatedError('bad token'));
  },
};
const auth = (who = 'analyst') => ({ authorization: `Bearer ${who}` });

let t: TestDatabase;
let clock: ManualClock;
let application: Application;
let server: FastifyInstance;

async function buildServer(env: Record<string, string> = {}) {
  const config = testConfig({
    WEBHOOK_SOURCES_JSON: JSON.stringify({
      suricata: { normalizer: 'suricata-eve', secret: SURICATA_SECRET },
      firewall: { normalizer: 'cef', secret: CEF_SECRET },
    }),
    ...env,
  });
  const app = createApplication(config, { db: t.db, redis: null, clock });
  const http = await buildHttpServer({
    config,
    modules: app.modules,
    authenticator,
    redis: null,
    logger: false,
    readiness: () => runReadinessChecks(app.readinessChecks),
  });
  return { app, http };
}

beforeAll(async () => {
  t = await createTestDatabase();
  clock = new ManualClock('2026-10-28T10:00:00.000Z');
  ({ app: application, http: server } = await buildServer());
});
afterAll(async () => {
  await server.close();
  await t.destroy();
});

/**
 * A server whose alerts API makes the first `parties` transactions that find no open alert
 * wait for each other before inserting: a deterministic way to force the INSERT race.
 */
function racyServer(parties: number) {
  const deps = application.deps;
  const alertsModule = createAlertsModule(deps, {
    detailSources: {
      enrichmentsFor: () => Promise.resolve([]),
      scoreFor: () => Promise.resolve(null),
      runsFor: () => Promise.resolve([]),
    },
  });
  const real = alertsModule.api;
  const waiting: (() => void)[] = [];
  let released = false;
  let lost = 0;
  const barrier = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= parties) {
        released = true;
        for (const w of waiting) w();
      }
      setTimeout(resolve, 3000).unref(); // never deadlock the test
    });
  const racy: AlertsPublicApi = {
    get: (id) => real.get(id),
    setStatus: (id, to, actor) => real.setStatus(id, to, actor),
    timesReceivedBetween: (from, to) => real.timesReceivedBetween(from, to),
    recordDuplicate: (trx, id, at) => real.recordDuplicate(trx, id, at),
    findOpenByFingerprint: async (trx, fp) => {
      const found = await real.findOpenByFingerprint(trx, fp);
      if (found === null && !released) await barrier();
      return found;
    },
    create: async (trx, alert) => {
      try {
        await real.create(trx, alert);
      } catch (error) {
        if (error instanceof OpenAlertExistsError) lost += 1;
        throw error;
      }
    },
  };
  const ingestion = createIngestionModule(deps, { alerts: racy });
  return {
    lostRaces: () => lost,
    http: buildHttpServer({
      config: deps.config,
      modules: [alertsModule.module, ingestion.module],
      authenticator,
      redis: null,
      logger: false,
      readiness: () => runReadinessChecks({}),
    }),
  };
}

function alertBody(overrides: Partial<CanonicalAlertInput> = {}): CanonicalAlertInput {
  return {
    source: { vendor: 'Fabrikam', product: 'EndpointShield', sourceAlertId: 'EPS-1' },
    title: 'Encoded PowerShell command spawned by Word',
    category: 'malware',
    severity: 'high',
    occurredAt: '2026-10-28T09:58:00.000Z',
    host: { hostname: 'HR-LT-007' },
    indicators: [{ type: 'domain', value: 'payload-cdn[.]example' }],
    mitre: [{ techniqueId: 'T1059.001', tacticId: 'TA0002' }],
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return server.inject({
    method: 'POST',
    url: '/api/v1/alerts',
    payload: body as object,
    headers: { ...auth(), ...headers },
  });
}

async function eventsFor(aggregateId: string) {
  return t.db
    .selectFrom('domain_events')
    .select(['type', 'payload'])
    .where('aggregate_id', '=', aggregateId)
    .orderBy('id')
    .execute();
}

async function alertRow(id: string) {
  return t.db.selectFrom('alerts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

function signed(
  sourceId: string,
  secret: string,
  body: string,
  extra: Record<string, string> = {},
) {
  const ts = String(Math.floor(clock.now().getTime() / 1000));
  return server.inject({
    method: 'POST',
    url: `/api/v1/ingest/webhooks/${sourceId}`,
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-spine-timestamp': ts,
      'x-spine-signature': `sha256=${signWebhook(secret, ts, body)}`,
      ...extra,
    },
  });
}

describe('POST /alerts', () => {
  it('creates an alert, stores normalized indicators and emits alert.ingested', async () => {
    const res = await post(alertBody());
    expect(res.statusCode).toBe(202);
    const { alertId, status } = res.json();
    expect(status).toBe('created');
    const row = await alertRow(alertId);
    expect(row).toMatchObject({ status: 'new', duplicate_count: 0, source_severity: 'high' });
    expect(row.mitre_technique_ids).toEqual(['T1059', 'T1059.001']);
    expect((row.canonical as { indicators: unknown[] }).indicators).toEqual([
      { type: 'domain', value: 'payload-cdn.example' },
      { type: 'hostname', value: 'hr-lt-007' },
    ]);
    const events = await eventsFor(alertId);
    expect(events.map((e) => e.type)).toEqual(['alert.ingested']);
    expect((events[0]?.payload as { alert: { id: string } }).alert.id).toBe(alertId);
  });

  it('deduplicates a repeat of an open alert and re-creates after closure', async () => {
    const body = alertBody({ source: { vendor: 'Acme', product: 'X', sourceAlertId: 'dup-1' } });
    const first = (await post(body)).json();
    clock.advance(1000);
    const second = await post(body);
    expect(second.json()).toEqual({
      alertId: first.alertId,
      status: 'deduplicated',
      duplicateOf: first.alertId,
    });
    const row = await alertRow(first.alertId);
    expect(row.duplicate_count).toBe(1);
    expect(row.last_seen_at.toISOString()).toBe(clock.now().toISOString());
    expect((await eventsFor(first.alertId)).map((e) => e.type)).toEqual([
      'alert.ingested',
      'alert.deduplicated',
    ]);

    await t.db
      .updateTable('alerts')
      .set({ status: 'resolved' })
      .where('id', '=', first.alertId)
      .execute();
    const third = (await post(body)).json();
    expect(third.status).toBe('created');
    expect(third.alertId).not.toBe(first.alertId);
  });

  it('collapses 20 concurrent ingests of the same alert into 1 open alert with 19 duplicates', async () => {
    // Without help, the first transaction commits before the others even get a pooled
    // connection, so the race this test is about never happens (see the journal). A barrier
    // holds the first transactions right after they saw "no open alert", so several of them
    // really do INSERT concurrently and all but one hit the partial unique index.
    const race = racyServer(4);
    const body = alertBody({ source: { vendor: 'Acme', product: 'X', sourceAlertId: 'race-20' } });
    const http = await race.http;
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          http.inject({ method: 'POST', url: '/api/v1/alerts', payload: body, headers: auth() }),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual(Array.from({ length: 20 }, () => 202));
      const statuses = results.map((r) => r.json().status as string);
      expect(statuses.filter((s) => s === 'created')).toHaveLength(1);
      expect(statuses.filter((s) => s === 'deduplicated')).toHaveLength(19);
      expect(race.lostRaces()).toBeGreaterThanOrEqual(1);
      const fingerprint = (await alertRow(results[0]!.json().alertId)).fingerprint;
      const rows = await t.db
        .selectFrom('alerts')
        .selectAll()
        .where('fingerprint', '=', fingerprint)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.duplicate_count).toBe(19);
      const types = (await eventsFor(rows[0]!.id)).map((e) => e.type);
      expect(types.filter((x) => x === 'alert.ingested')).toHaveLength(1);
      expect(types.filter((x) => x === 'alert.deduplicated')).toHaveLength(19);
    } finally {
      await http.close();
    }
  });

  it('rejects invalid bodies (400) and non-analysts (403)', async () => {
    expect((await post({ title: 'x' })).statusCode).toBe(400);
    expect((await post(alertBody(), auth('viewer'))).statusCode).toBe(403);
  });

  it('caps an oversized raw payload', async () => {
    const res = await post(
      alertBody({
        source: { vendor: 'Acme', product: 'Raw', sourceAlertId: 'raw-1' },
        raw: { blob: 'x'.repeat(70_000) },
      }),
    );
    // 70 KB body is under the 1 MiB JSON limit, but over the 64 KiB raw cap.
    const row = await alertRow(res.json().alertId);
    expect((row.canonical as { raw: unknown }).raw).toEqual({ truncated: true, bytes: 70_011 });
  });
});

describe('Idempotency-Key', () => {
  const body = alertBody({ source: { vendor: 'Acme', product: 'Idem', sourceAlertId: 'idem-1' } });

  it('replays the stored response for the same key and body', async () => {
    const first = await post(body, { 'idempotency-key': 'key-1' });
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const replay = await post(body, { 'idempotency-key': 'key-1' });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect((await alertRow(first.json().alertId)).duplicate_count).toBe(0);
  });

  it('returns 409 idempotency-key-reused for the same key with another body', async () => {
    const res = await post({ ...body, title: 'something else' }, { 'idempotency-key': 'key-1' });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://spine.dev/problems/idempotency-key-reused');
  });

  it('scopes keys per principal', async () => {
    const res = await post(body, { 'idempotency-key': 'key-1', ...auth('other') });
    expect(res.headers['idempotent-replay']).toBeUndefined();
    expect(res.json().status).toBe('deduplicated');
  });

  it('serializes concurrent requests with one key: one is processed, the rest replay it', async () => {
    const b = alertBody({ source: { vendor: 'Acme', product: 'Idem', sourceAlertId: 'idem-2' } });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(b, { 'idempotency-key': 'key-2' })),
    );
    const replays = results.filter((r) => r.headers['idempotent-replay'] === 'true');
    expect(replays).toHaveLength(4);
    expect(new Set(results.map((r) => r.json().alertId)).size).toBe(1);
    expect((await alertRow(results[0]!.json().alertId)).duplicate_count).toBe(0);
  });

  it('validates the header and cleans up expired keys', async () => {
    expect((await post(body, { 'idempotency-key': 'has space' })).statusCode).toBe(400);
    await t.db
      .insertInto('idempotency_keys')
      .values({
        scope: 'user:x',
        key: 'old',
        request_hash: Buffer.alloc(32),
        response_status: 202,
        response_body: '{}',
        created_at: new Date(clock.now().getTime() - 25 * 3600 * 1000),
      })
      .execute();
    const task = idempotencyCleanupTask({
      store: new PostgresIdempotencyStore(t.db),
      clock,
      logger: application.deps.logger,
    });
    expect(await task.sweep()).toBe(1);
    const left = await t.db.selectFrom('idempotency_keys').select('key').execute();
    expect(left.map((r) => r.key)).not.toContain('old');
  });
});

describe('POST /ingest/webhooks/:sourceId', () => {
  const c2 = suricataEveLines()[0]!;

  it('accepts a correctly signed Suricata event (raw body is what gets verified)', async () => {
    const res = await signed('suricata', SURICATA_SECRET, c2);
    expect(res.statusCode).toBe(202);
    // Ingestion has its own, larger rate-limit bucket (ADR-0024), not the global 600/min.
    expect(res.headers['x-ratelimit-limit']).toBe('6000');
    const row = await alertRow(res.json().alertId);
    expect(row.source_product).toBe('Suricata');
    // The 64-bit flow_id survived because the normalizer read the raw text.
    expect((row.canonical as { source: { sourceAlertId: string } }).source.sourceAlertId).toBe(
      '1844674407370955161:2035465',
    );
  });

  it('accepts a CEF line from a text/plain source', async () => {
    const res = await signed('firewall', CEF_SECRET, cefLines()[0]!, {
      'content-type': 'text/plain',
    });
    expect(res.statusCode).toBe(202);
  });

  it('rejects bad, stale and missing signatures with 401', async () => {
    const tampered = await signed('suricata', 'wrong-secret-wrong-secret-wrong-secret', c2);
    expect(tampered.statusCode).toBe(401);
    const ts = String(Math.floor(clock.now().getTime() / 1000) - 600);
    const stale = await server.inject({
      method: 'POST',
      url: '/api/v1/ingest/webhooks/suricata',
      payload: c2,
      headers: {
        'content-type': 'application/json',
        'x-spine-timestamp': ts,
        'x-spine-signature': `sha256=${signWebhook(SURICATA_SECRET, ts, c2)}`,
      },
    });
    expect(stale.statusCode).toBe(401);
    const unsigned = await server.inject({
      method: 'POST',
      url: '/api/v1/ingest/webhooks/suricata',
      payload: c2,
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it('returns a plain 404 for unknown sources, including prototype keys', async () => {
    for (const id of ['nope', 'constructor', '__proto__'.replace(/_/g, '-')]) {
      const res = await signed(id, SURICATA_SECRET, c2);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('suricata');
    }
  });

  it('returns 400 for a signed payload the normalizer rejects', async () => {
    const res = await signed('suricata', SURICATA_SECRET, suricataEveLines()[1]!);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('not an alert');
  });

  it('treats an exact replay of a signed webhook as a no-op (security review F3)', async () => {
    // A unique event (its own flow_id), so this test doesn't consume a fixture other tests expect.
    const line = suricataEveLines()[0]!.replace(/"flow_id":\s*\d+/, '"flow_id": 777000111222');
    expect(line).toContain('777000111222');
    clock.advance(60_000);
    const first = await signed('suricata', SURICATA_SECRET, line);
    expect(first.statusCode).toBe(202);
    const { alertId } = first.json();
    const before = await alertRow(alertId);
    // An attacker re-sends the captured request (same timestamp, body and signature).
    const replay = await signed('suricata', SURICATA_SECRET, line);
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect((await alertRow(alertId)).duplicate_count).toBe(before.duplicate_count);
    // A genuine re-send by the sensor (new timestamp, so a new signature) still counts.
    clock.advance(1_000);
    const resend = await signed('suricata', SURICATA_SECRET, line);
    expect(resend.headers['idempotent-replay']).toBeUndefined();
    expect((await alertRow(alertId)).duplicate_count).toBe(before.duplicate_count + 1);
  });

  it('supports Idempotency-Key scoped to the webhook source', async () => {
    const line = suricataEveLines()[2]!;
    const first = await signed('suricata', SURICATA_SECRET, line, { 'idempotency-key': 'wh-1' });
    const replay = await signed('suricata', SURICATA_SECRET, line, { 'idempotency-key': 'wh-1' });
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
  });
});

describe('POST /ingest/batch', () => {
  function batch(body: string, format: string, contentType = 'text/plain') {
    return server.inject({
      method: 'POST',
      url: `/api/v1/ingest/batch?format=${format}`,
      payload: body,
      headers: { ...auth(), 'content-type': contentType },
    });
  }

  it('imports a Suricata EVE file: alerts in, telemetry skipped', async () => {
    const res = await batch(suricataEveLines().join('\n'), 'suricata-eve');
    expect(res.statusCode).toBe(200);
    // Line 1 and 3 were already ingested by the webhook tests above → deduplicated.
    expect(res.json()).toEqual({
      accepted: 2,
      deduplicated: 2,
      rejected: 0,
      skipped: 2,
      errors: [],
    });
  });

  it('imports CEF lines, using receivedAt when a line has no event time', async () => {
    const res = await batch(cefLines().join('\n'), 'cef');
    expect(res.json()).toMatchObject({ accepted: 4, deduplicated: 1, rejected: 0 });
  });

  it('reports per-line errors with partial success, and dedups repeats inside one batch', async () => {
    const good = JSON.stringify(
      alertBody({ source: { vendor: 'Acme', product: 'Batch', sourceAlertId: 'b-1' } }),
    );
    const body = [good, '{"title":""}', good, 'not json', good].join('\n');
    const res = await batch(body, 'ndjson', 'application/x-ndjson');
    expect(res.json()).toMatchObject({ accepted: 1, deduplicated: 2, rejected: 2, skipped: 0 });
    expect(res.json().errors.map((e: { line: number }) => e.line)).toEqual([2, 4]);
  });

  it('rejects bodies over 10 MiB with 413', async () => {
    const res = await batch('x'.repeat(10 * 1024 * 1024 + 1), 'ndjson');
    expect(res.statusCode).toBe(413);
  });
});

describe('back-pressure', () => {
  it('answers 503 + Retry-After and fails readiness when the outbox backlog is too large', async () => {
    const backlog = await t.db
      .selectFrom('domain_events')
      .select(sql<string>`count(*)`.as('n'))
      .where('dispatched_at', 'is', null)
      .executeTakeFirstOrThrow();
    expect(Number(backlog.n)).toBeGreaterThan(1);
    const { app, http } = await buildServer({ INGEST_MAX_BACKLOG: '1' });
    try {
      const res = await http.inject({
        method: 'POST',
        url: '/api/v1/alerts',
        payload: alertBody(),
        headers: auth(),
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.json().type).toBe('https://spine.dev/problems/overloaded');
      const ready = await runReadinessChecks(app.readinessChecks);
      expect(ready.checks['ingest-backlog']).toBe('fail');
    } finally {
      await http.close();
    }
    const ready = await runReadinessChecks(application.readinessChecks);
    expect(ready.checks['ingest-backlog']).toBe('ok');
  });
});
