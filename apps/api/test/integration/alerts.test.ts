/* eslint-disable @typescript-eslint/no-unsafe-call -- inject().json() is typed any; asserting on it is the point (as in eslint.config.js) */
import type { AlertSummary, CanonicalAlertInput, DomainEvent } from '@spine/shared-schema';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication, type Application } from '../../src/composition.js';
import { UnauthenticatedError } from '../../src/platform/errors.js';
import type { Authenticator } from '../../src/platform/http/access.js';
import { buildHttpServer, runReadinessChecks } from '../../src/platform/http/server.js';
import { ManualClock } from '../../src/platform/runtime.js';
import { testConfig } from '../support/config.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';

const ANALYST_ID = '00000000-0000-7000-8000-00000000b001';
const users: Record<string, { id: string; role: 'viewer' | 'analyst' }> = {
  analyst: { id: ANALYST_ID, role: 'analyst' },
  viewer: { id: '00000000-0000-7000-8000-00000000b002', role: 'viewer' },
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
let app: Application;
let server: FastifyInstance;

beforeAll(async () => {
  t = await createTestDatabase();
  clock = new ManualClock('2026-10-28T08:00:00.000Z');
  const config = testConfig();
  app = createApplication(config, { db: t.db, redis: null, clock });
  server = await buildHttpServer({
    config,
    modules: app.modules,
    authenticator,
    redis: null,
    logger: false,
    readiness: () => runReadinessChecks(app.readinessChecks),
  });
});
afterAll(async () => {
  await server.close();
  await t.destroy();
});

let seq = 0;
/** Ingests an alert through the real API, one second after the previous one. */
async function ingest(overrides: Partial<CanonicalAlertInput> = {}): Promise<string> {
  seq += 1;
  clock.advance(1000);
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/alerts',
    headers: auth(),
    payload: {
      source: { vendor: 'Acme', product: 'EdgeWall', sourceAlertId: `a-${seq}` },
      title: `Alert number ${seq}`,
      category: 'intrusion',
      severity: 'medium',
      occurredAt: '2026-10-28T07:00:00.000Z',
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(202);
  return res.json().alertId as string;
}

/** Delivers an `alert.scored` event to the projection subscriber, as the worker would. */
async function score(alertId: string, value: number, computedAt = clock.now().toISOString()) {
  const handler = app.subscriptions.byHandlerName('alerts.project-score');
  const alert = await app.deps.db
    .selectFrom('alerts')
    .select('id')
    .where('id', '=', alertId)
    .executeTakeFirstOrThrow();
  const full = await (
    await import('../../src/modules/alerts/index.js')
  )
    .createAlertsModule(app.deps, {
      detailSources: {
        enrichmentsFor: () => Promise.resolve([]),
        scoreFor: () => Promise.resolve(null),
        runsFor: () => Promise.resolve([]),
      },
    })
    .api.get(alert.id);
  const severity =
    value >= 80
      ? 'critical'
      : value >= 60
        ? 'high'
        : value >= 40
          ? 'medium'
          : value >= 20
            ? 'low'
            : 'informational';
  const event = {
    eventId: '00000000-0000-7000-9000-000000000001',
    type: 'alert.scored',
    version: 1,
    aggregateId: alertId,
    occurredAt: computedAt,
    payload: {
      alert: full!,
      enrichments: [],
      score: {
        score: value,
        rawScore: value,
        severity,
        rulesetVersion: 1,
        factors: [{ ruleId: 'baseline', description: 'baseline', points: value }],
        dataGaps: [],
        computedAt,
      },
    },
  } as DomainEvent<'alert.scored'>;
  await handler!.handle(event);
}

async function list(
  query: string,
  who = 'viewer',
): Promise<{ items: AlertSummary[]; nextCursor: string | null }> {
  const res = await server.inject({ url: `/api/v1/alerts?${query}`, headers: auth(who) });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function patch(id: string, payload: object, who = 'analyst') {
  return server.inject({
    method: 'PATCH',
    url: `/api/v1/alerts/${id}`,
    payload,
    headers: auth(who),
  });
}

const ids = { ps: '', cmd: '', lsass: '', scan: '', phish: '' };

describe('seed', () => {
  it('ingests a varied set of alerts', async () => {
    ids.ps = await ingest({
      title: 'Encoded PowerShell 100% obfuscated',
      category: 'malware',
      severity: 'high',
      mitre: [{ techniqueId: 'T1059.001', tacticId: 'TA0002' }],
      source: { vendor: 'Fabrikam', product: 'EndpointShield', sourceAlertId: 'ps' },
    });
    ids.cmd = await ingest({
      title: 'cmd.exe spawned by Excel',
      category: 'malware',
      severity: 'low',
      mitre: [{ techniqueId: 'T1059.003' }],
      source: { vendor: 'Fabrikam', product: 'EndpointShield', sourceAlertId: 'cmd' },
    });
    ids.lsass = await ingest({
      title: 'LSASS memory read',
      category: 'credential_access',
      severity: 'critical',
      mitre: [{ techniqueId: 'T1003.001' }],
    });
    ids.scan = await ingest({
      title: 'Port scan from 198.51.100.23',
      category: 'reconnaissance',
      severity: 'low',
    });
    ids.phish = await ingest({
      title: 'Phishing link clicked',
      category: 'phishing',
      severity: 'high',
    });
    await score(ids.ps, 90);
    await score(ids.lsass, 75);
    await score(ids.scan, 10);
    await score(ids.phish, 75);
    expect(Object.keys(ids)).toHaveLength(5);
  });
});

describe('GET /alerts filters', () => {
  it('filters by status, category and source', async () => {
    expect((await list('category=malware')).items.map((a) => a.id).sort()).toEqual(
      [ids.cmd, ids.ps].sort(),
    );
    expect((await list('source=fabrikam')).items).toHaveLength(2);
    expect((await list('source=EndpointShield')).items).toHaveLength(2);
    expect((await list('status=new&status=triaged')).items.length).toBeGreaterThanOrEqual(5);
    expect((await list('status=resolved')).items).toHaveLength(0);
  });

  it('filters by effective severity: scored severity, or the source one until scored', async () => {
    // cmd is unscored with source severity "low"; scan was scored 10 → informational.
    expect((await list('severity=low')).items.map((a) => a.id)).toEqual([ids.cmd]);
    expect((await list('severity=critical')).items.map((a) => a.id)).toEqual([ids.ps]);
    expect(
      (await list('severity=high&severity=informational')).items.map((a) => a.id).sort(),
    ).toEqual([ids.lsass, ids.phish, ids.scan].sort());
  });

  it('filters by score range', async () => {
    expect((await list('minScore=70&maxScore=80')).items.map((a) => a.id).sort()).toEqual(
      [ids.lsass, ids.phish].sort(),
    );
  });

  it('searches titles with ILIKE, treating % and _ literally', async () => {
    expect((await list('q=powershell')).items.map((a) => a.id)).toEqual([ids.ps]);
    expect((await list(`q=${encodeURIComponent('100%')}`)).items.map((a) => a.id)).toEqual([
      ids.ps,
    ]);
    expect((await list(`q=${encodeURIComponent('%')}`)).items.map((a) => a.id)).toEqual([ids.ps]);
    expect((await list('q=_')).items).toHaveLength(0);
  });

  it('filters by ATT&CK technique; a parent technique matches its sub-techniques', async () => {
    expect((await list('technique=T1059')).items.map((a) => a.id).sort()).toEqual(
      [ids.cmd, ids.ps].sort(),
    );
    expect((await list('technique=T1059.001')).items.map((a) => a.id)).toEqual([ids.ps]);
    expect((await list('technique=t1003')).items.map((a) => a.id)).toEqual([ids.lsass]);
  });

  it('filters by received time window and assignee', async () => {
    const all = (await list('limit=200&sort=receivedAt&order=asc')).items;
    const third = all.find((a) => a.id === ids.lsass)!;
    const window = await list(
      `from=${encodeURIComponent(third.receivedAt)}&to=${encodeURIComponent(new Date(Date.parse(third.receivedAt) + 2000).toISOString())}`,
    );
    expect(window.items.map((a) => a.id).sort()).toEqual([ids.lsass, ids.scan].sort());
    expect((await patch(ids.scan, { assigneeId: ANALYST_ID })).statusCode).toBe(200);
    expect((await list(`assigneeId=${ANALYST_ID}`)).items.map((a) => a.id)).toEqual([ids.scan]);
  });

  it('rejects invalid queries with 400', async () => {
    expect(
      (await server.inject({ url: '/api/v1/alerts?limit=0', headers: auth('viewer') })).statusCode,
    ).toBe(400);
    expect(
      (await server.inject({ url: '/api/v1/alerts?cursor=garbage', headers: auth('viewer') }))
        .statusCode,
    ).toBe(400);
    expect((await server.inject({ url: '/api/v1/alerts' })).statusCode).toBe(401);
  });
});

/** Walks every page of a listing and returns the ids in order. */
async function walk(query: string, onPage?: (page: number) => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const res = await list(`${query}${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...res.items.map((a) => a.id));
    if (!res.nextCursor) return out;
    cursor = res.nextCursor;
    if (onPage) await onPage(page);
  }
  throw new Error('too many pages');
}

describe('keyset pagination', () => {
  it('walks score DESC NULLS LAST across the scored/unscored boundary', async () => {
    const ordered = await walk('sort=score&order=desc&limit=2');
    const all = (await list('sort=score&order=desc&limit=200')).items;
    expect(ordered).toEqual(all.map((a) => a.id));
    expect(ordered.slice(0, 4)).toEqual([
      ids.ps,
      ...[ids.lsass, ids.phish].sort().reverse(),
      ids.scan,
    ]);
    const scores = all.map((a) => a.score);
    const firstNull = scores.indexOf(null);
    expect(scores.slice(firstNull).every((s) => s === null)).toBe(true);
    expect(new Set(ordered).size).toBe(ordered.length);
  });

  it('walks score ASC with NULLs still last', async () => {
    const ordered = await walk('sort=score&order=asc&limit=1');
    const all = (await list('sort=score&order=asc&limit=200')).items;
    expect(ordered).toEqual(all.map((a) => a.id));
    expect(all[0]?.id).toBe(ids.scan);
    expect(all.at(-1)?.score).toBeNull();
  });

  it('stays stable while new alerts arrive (receivedAt DESC): no duplicates, no skips', async () => {
    const before = (await list('limit=200')).items.map((a) => a.id);
    const walked = await walk('limit=2', async () => {
      await ingest({ title: 'arrived during pagination' });
    });
    expect(walked).toEqual(before);
  });

  it('walks receivedAt ASC and refuses a cursor from another sort mode', async () => {
    const asc = await walk('sort=receivedAt&order=asc&limit=3');
    const all = (await list('sort=receivedAt&order=asc&limit=200')).items.map((a) => a.id);
    expect(asc).toEqual(all);
    const scorePage = await list('sort=score&limit=1');
    const res = await server.inject({
      url: `/api/v1/alerts?sort=receivedAt&cursor=${scorePage.nextCursor}`,
      headers: auth('viewer'),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /alerts/:id', () => {
  it('returns the detail view (other modules wired as placeholders)', async () => {
    const res = await server.inject({ url: `/api/v1/alerts/${ids.ps}`, headers: auth('viewer') });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.summary).toMatchObject({
      id: ids.ps,
      score: 90,
      severity: 'critical',
      sourceSeverity: 'high',
    });
    expect(detail.alert).toMatchObject({ id: ids.ps, status: 'new', duplicateCount: 0 });
    expect(detail.alert.mitre).toEqual([{ techniqueId: 'T1059.001', tacticId: 'TA0002' }]);
    expect(detail).toMatchObject({ enrichments: [], score: null, runs: [] });
  });

  it('answers 404 for unknown ids and 400 for malformed ones', async () => {
    const unknown = await server.inject({
      url: '/api/v1/alerts/00000000-0000-7000-8000-0000000fffff',
      headers: auth('viewer'),
    });
    expect(unknown.statusCode).toBe(404);
    expect(
      (await server.inject({ url: '/api/v1/alerts/nope', headers: auth('viewer') })).statusCode,
    ).toBe(400);
  });
});

describe('PATCH /alerts/:id', () => {
  async function statusEvents(id: string) {
    return t.db
      .selectFrom('domain_events')
      .select('payload')
      .where('aggregate_id', '=', id)
      .where('type', '=', 'alert.status_changed')
      .orderBy('id')
      .execute();
  }

  it('applies legal transitions and emits alert.status_changed with the actor', async () => {
    const res = await patch(ids.phish, { status: 'triaged' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ids.phish, status: 'triaged', resolvedAt: null });
    const events = await statusEvents(ids.phish);
    expect(events.map((e) => e.payload)).toEqual([
      {
        alertId: ids.phish,
        from: 'new',
        to: 'triaged',
        actorId: ANALYST_ID,
        at: clock.now().toISOString(),
      },
    ]);
  });

  it('treats setting the current status as a no-op (no event)', async () => {
    expect((await patch(ids.phish, { status: 'triaged' })).statusCode).toBe(200);
    expect(await statusEvents(ids.phish)).toHaveLength(1);
  });

  it('answers 409 on an illegal transition and 403 for viewers', async () => {
    expect((await patch(ids.phish, { status: 'new' })).statusCode).toBe(409);
    expect((await patch(ids.phish, { status: 'in_progress' }, 'viewer')).statusCode).toBe(403);
    expect((await patch(ids.phish, {})).statusCode).toBe(400);
  });

  it('keeps the FIRST resolvedAt across reopen and re-close (ADR-0036)', async () => {
    clock.advance(60_000);
    const firstClose = clock.now().toISOString();
    expect((await patch(ids.phish, { status: 'resolved' })).json().resolvedAt).toBe(firstClose);
    clock.advance(60_000);
    const reopened = (await patch(ids.phish, { status: 'in_progress' })).json();
    expect(reopened).toMatchObject({ status: 'in_progress', resolvedAt: firstClose });
    clock.advance(60_000);
    expect((await patch(ids.phish, { status: 'false_positive' })).json().resolvedAt).toBe(
      firstClose,
    );
  });

  it('refuses to reopen when a newer open alert has the same fingerprint (409)', async () => {
    const source = { vendor: 'Acme', product: 'EdgeWall', sourceAlertId: 'reopen-1' };
    const old = await ingest({ source, title: 'Recurring detection' });
    expect((await patch(old, { status: 'resolved' })).statusCode).toBe(200);
    const fresh = await ingest({ source, title: 'Recurring detection' });
    expect(fresh).not.toBe(old);
    const res = await patch(old, { status: 'in_progress' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('same fingerprint');
  });

  it('answers 404 for unknown alerts and 422 for unknown cases', async () => {
    expect(
      (await patch('00000000-0000-7000-8000-0000000fffff', { status: 'triaged' })).statusCode,
    ).toBe(404);
    expect(
      (await patch(ids.cmd, { caseId: '00000000-0000-7000-8000-0000000fffff' })).statusCode,
    ).toBe(422);
  });
});

describe('score projection (alerts.project-score)', () => {
  it('is idempotent and ignores an older score delivered late (ADR-0038)', async () => {
    const at = clock.now().toISOString();
    await score(ids.cmd, 55, at);
    await score(ids.cmd, 55, at);
    await score(ids.cmd, 30, new Date(Date.parse(at) - 60_000).toISOString());
    const summary = (await list('limit=200')).items.find((a) => a.id === ids.cmd)!;
    expect(summary).toMatchObject({ score: 55, severity: 'medium' });
  });
});

describe('cases', () => {
  let caseId = '';

  it('creates a case, links alerts and records the creator', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/cases',
      headers: auth(),
      payload: {
        title: 'Fabrikam endpoint intrusion',
        description: 'PowerShell + cmd',
        alertIds: [ids.ps, ids.cmd],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    caseId = created.id;
    expect(created).toMatchObject({
      status: 'open',
      createdBy: ANALYST_ID,
      description: 'PowerShell + cmd',
    });
    expect(created.alertIds.sort()).toEqual([ids.ps, ids.cmd].sort());
    expect((await list(`limit=200`)).items.find((a) => a.id === ids.ps)?.caseId).toBe(caseId);
  });

  it('refuses unknown alert ids (422) and viewers (403)', async () => {
    const bad = await server.inject({
      method: 'POST',
      url: '/api/v1/cases',
      headers: auth(),
      payload: { title: 'x', alertIds: ['00000000-0000-7000-8000-0000000fffff'] },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].message).toContain('unknown alert');
    const viewer = await server.inject({
      method: 'POST',
      url: '/api/v1/cases',
      headers: auth('viewer'),
      payload: { title: 'x' },
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('returns the case with its alert summaries', async () => {
    const res = await server.inject({ url: `/api/v1/cases/${caseId}`, headers: auth('viewer') });
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .alerts.map((a: AlertSummary) => a.id)
        .sort(),
    ).toEqual([ids.ps, ids.cmd].sort());
    expect(
      (
        await server.inject({
          url: '/api/v1/cases/00000000-0000-7000-8000-0000000fffff',
          headers: auth('viewer'),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('updates fields and links/unlinks alerts; also via PATCH /alerts caseId', async () => {
    clock.advance(1000);
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/cases/${caseId}`,
      headers: auth(),
      payload: {
        status: 'in_progress',
        title: 'Renamed',
        addAlertIds: [ids.lsass],
        removeAlertIds: [ids.cmd],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'in_progress',
      title: 'Renamed',
      updatedAt: clock.now().toISOString(),
    });
    expect(res.json().alertIds.sort()).toEqual([ids.lsass, ids.ps].sort());
    expect((await patch(ids.scan, { caseId })).json().caseId).toBe(caseId);
    expect((await patch(ids.scan, { caseId: null })).json().caseId).toBeNull();
    const missing = await server.inject({
      method: 'PATCH',
      url: '/api/v1/cases/00000000-0000-7000-8000-0000000fffff',
      headers: auth(),
      payload: { title: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('lists cases newest first with a status filter and pagination', async () => {
    for (const title of ['Second case', 'Third case']) {
      clock.advance(1000);
      await server.inject({
        method: 'POST',
        url: '/api/v1/cases',
        headers: auth(),
        payload: { title },
      });
    }
    const page1 = (
      await server.inject({ url: '/api/v1/cases?limit=2', headers: auth('viewer') })
    ).json();
    expect(page1.items.map((c: { title: string }) => c.title)).toEqual([
      'Third case',
      'Second case',
    ]);
    const page2 = (
      await server.inject({
        url: `/api/v1/cases?limit=2&cursor=${page1.nextCursor}`,
        headers: auth('viewer'),
      })
    ).json();
    expect(page2.items.map((c: { id: string }) => c.id)).toEqual([caseId]);
    expect(page2.items[0].alertIds).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const inProgress = (
      await server.inject({ url: '/api/v1/cases?status=in_progress', headers: auth('viewer') })
    ).json();
    expect(inProgress.items.map((c: { id: string }) => c.id)).toEqual([caseId]);
  });
});

describe('public API', () => {
  it('setStatus validates transitions for automation callers (actorId null)', async () => {
    const alertsModule = (await import('../../src/modules/alerts/index.js')).createAlertsModule(
      app.deps,
      {
        detailSources: {
          enrichmentsFor: () => Promise.resolve([]),
          scoreFor: () => Promise.resolve(null),
          runsFor: () => Promise.resolve([]),
        },
      },
    );
    await alertsModule.api.setStatus(ids.lsass, 'in_progress', null);
    expect((await alertsModule.api.get(ids.lsass))?.status).toBe('in_progress');
    await expect(alertsModule.api.setStatus(ids.lsass, 'new', null)).rejects.toMatchObject({
      slug: 'conflict',
    });
    expect(await alertsModule.api.get('00000000-0000-7000-8000-0000000fffff')).toBeNull();
  });
});
