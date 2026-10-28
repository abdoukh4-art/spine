import {
  AlertSchema,
  ApprovalSchema,
  AuditEntrySchema,
  PlaybookRecordSchema,
  RunDetailSchema,
  ScoreExplanationSchema,
  SimulatedActionSchema,
  UserSchema,
} from '@spine/shared-schema';
import { describe, expect, it } from 'vitest';
import { ApiError, createSpineApi, HttpClient } from '../lib/api';
import { TEST_NOW } from '../test/time';
import { createDemoServer } from './demo';
import { createFakeDb, DEMO_PASSWORD, DEMO_USERS } from './fixtures';
import { documentCookieJar, memoryCookieJar } from './http';
import { fakeId, ID_KIND, seededRandom } from './ids';
import { durationStat, percentile } from './metrics';
import { FakeSpineServer } from './server';
import { toYaml } from './yaml';

function backend(as: keyof typeof DEMO_USERS | null = 'admin') {
  const server = new FakeSpineServer({ now: () => TEST_NOW });
  if (as) server.signInAs(DEMO_USERS[as].email);
  const api = createSpineApi(new HttpClient({ fetch: server.fetch }));
  return { server, api };
}

const status = (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e: unknown) => (e instanceof ApiError ? e.status : -1),
  );

describe('fixtures', () => {
  const db = createFakeDb(TEST_NOW);

  it('are valid against every shared schema', () => {
    for (const a of db.alerts) {
      expect(AlertSchema.safeParse(a.alert).success, a.alert.title).toBe(true);
      if (a.score) expect(ScoreExplanationSchema.safeParse(a.score).success).toBe(true);
    }
    for (const r of db.runs) expect(RunDetailSchema.safeParse(r.run).success, r.run.id).toBe(true);
    for (const x of db.approvals) expect(ApprovalSchema.safeParse(x).success).toBe(true);
    for (const x of db.simulatedActions)
      expect(SimulatedActionSchema.safeParse(x).success).toBe(true);
    for (const x of db.audit) expect(AuditEntrySchema.safeParse(x).success).toBe(true);
    for (const x of db.playbooks) expect(PlaybookRecordSchema.safeParse(x).success).toBe(true);
    for (const x of db.users) expect(UserSchema.safeParse(x).success).toBe(true);
  });

  it('are deterministic', () => {
    expect(JSON.stringify(createFakeDb(TEST_NOW))).toBe(JSON.stringify(createFakeDb(TEST_NOW)));
    const r = seededRandom(1);
    expect(r()).toBe(seededRandom(1)());
  });

  it('have score factors that add up to the raw score', () => {
    for (const a of db.alerts) {
      if (!a.score) continue;
      expect(a.score.factors.reduce((s, f) => s + f.points, 0)).toBe(a.score.rawScore);
    }
  });

  it('derive step states from events', () => {
    const compensated = db.runs[4]!.run;
    expect(compensated.status).toBe('compensated');
    expect(compensated.steps.find((s) => s.stepId === 'block-ip')?.status).toBe('compensated');
    expect(compensated.steps.find((s) => s.stepId === 'open-ticket')).toMatchObject({
      status: 'failed',
      attempts: 2,
    });
  });

  it('builds ids that look like UUIDv7', () => {
    expect(fakeId(ID_KIND.alert, 255)).toBe('0192f0a0-0002-7000-8000-0000000000ff');
  });
});

describe('fake server honours the contract', () => {
  it('every endpoint the console uses returns schema-valid data (client validates)', async () => {
    const { api } = backend('admin');
    await api.auth.refresh();
    const alerts = await api.alerts.list({ limit: 200 });
    expect(alerts.items.length).toBeGreaterThan(100);
    for (const a of alerts.items.slice(0, 20)) await api.alerts.get(a.id);
    await api.auth.me();
    await api.cases.list();
    await api.enrichment.providers();
    await api.scoring.ruleset();
    for (const p of await api.playbooks.list()) await api.playbooks.get(p.id);
    for (const r of (await api.runs.list({ limit: 200 })).items) await api.runs.get(r.id);
    for (const s of ['pending', 'approved', 'rejected', 'expired'] as const)
      await api.approvals.list({ status: s });
    await api.simulatedActions.list();
    await api.metrics.summary();
    await api.metrics.summary({
      from: new Date(TEST_NOW - 86_400_000).toISOString(),
      to: new Date(TEST_NOW).toISOString(),
    });
    await api.users.list();
    await api.audit.list({
      action: 'login',
      from: '2026-01-01T00:00:00.000Z',
      to: '2027-01-01T00:00:00.000Z',
    });
  });

  it('enforces authentication and roles like the API (401/403)', async () => {
    const anonymous = backend(null);
    expect(await status(anonymous.api.alerts.list())).toBe(401);
    const viewer = backend('viewer');
    await viewer.api.auth.refresh();
    expect(
      await status(viewer.api.alerts.update(fakeId(ID_KIND.alert, 1), { status: 'triaged' })),
    ).toBe(403);
    expect(await status(viewer.api.users.list())).toBe(403);
    const analyst = backend('analyst');
    await analyst.api.auth.refresh();
    expect(await status(analyst.api.playbooks.setEnabled('phishing-triage', false))).toBe(403);
    expect(await status(analyst.api.audit.list())).toBe(403);
  });

  it('requires the CSRF header on refresh and logout, and rejects disabled users', async () => {
    const { server } = backend('analyst');
    const noCsrf = await server.fetch('/api/v1/auth/refresh', { method: 'POST' });
    expect(noCsrf.status).toBe(403);
    expect((await server.fetch('/api/v1/auth/logout', { method: 'POST' })).status).toBe(403);
    const unknown = await server.fetch('/api/v1/nope', {});
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('Content-Type')).toBe('application/problem+json');
    const { api } = backend(null);
    expect(await status(api.auth.login('dan@spine.local', DEMO_PASSWORD))).toBe(401);
    expect(await status(api.auth.login('nobody@spine.local', DEMO_PASSWORD))).toBe(401);
    expect(await status(api.auth.login('not-an-email', DEMO_PASSWORD))).toBe(400);
    await expect(api.auth.login('SAM@spine.local', DEMO_PASSWORD)).resolves.toMatchObject({
      user: { role: 'analyst' },
    });
  });

  it('validates alert transitions and filters', async () => {
    const { api } = backend('analyst');
    await api.auth.refresh();
    const closed = fakeId(ID_KIND.alert, 9);
    expect(await status(api.alerts.update(closed, { status: 'triaged' }))).toBe(409);
    await expect(api.alerts.update(closed, { status: 'in_progress' })).resolves.toMatchObject({
      resolvedAt: null,
    });
    expect(await status(api.alerts.update(closed, { assigneeId: fakeId(ID_KIND.user, 999) }))).toBe(
      400,
    );
    expect(await status(api.alerts.get(fakeId(ID_KIND.alert, 9999)))).toBe(404);
    const bySeverity = await api.alerts.list({
      severity: ['critical'],
      sort: 'score',
      order: 'asc',
      limit: 200,
    });
    expect(bySeverity.items.every((a) => (a.severity ?? a.sourceSeverity) === 'critical')).toBe(
      true,
    );
    const scores = bySeverity.items.map((a) => a.score ?? -1);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect((await api.alerts.list({ technique: 'T1110' })).items).toHaveLength(1);
    expect(
      await status(api.http.request({ path: '/alerts', query: { status: 'bogus' }, schema: null })),
    ).toBe(400);
  });

  it('paginates with opaque cursors', async () => {
    const { api } = backend('viewer');
    await api.auth.refresh();
    const first = await api.alerts.list({ limit: 100 });
    const second = await api.alerts.list({ limit: 100, cursor: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((a) => a.id)).size).toBe(150);
  });

  it('runs a playbook to its approval gate, then on to success after approval', async () => {
    const { api, server } = backend('analyst');
    await api.auth.refresh();
    const { runId } = await api.playbooks.startRun(
      'contain-c2-beacon',
      fakeId(ID_KIND.alert, 1),
      false,
    );
    let run = await api.runs.get(runId);
    for (let i = 0; i < 20 && run.status !== 'waiting_approval'; i++)
      run = await api.runs.get(runId);
    expect(run.status).toBe('waiting_approval');
    const approval = (await api.approvals.list({ status: 'pending' })).items.find(
      (a) => a.runId === runId,
    )!;
    await api.approvals.decide(approval.id, { decision: 'approve' });
    expect(await status(api.approvals.decide(approval.id, { decision: 'reject' }))).toBe(409);
    for (let i = 0; i < 20 && run.status !== 'succeeded'; i++) run = await api.runs.get(runId);
    expect(run.status).toBe('succeeded');
    expect(run.steps.find((s) => s.stepId === 'block-ip')?.status).toBe('succeeded');
    expect(
      server.db.simulatedActions.some((a) => a.runId === runId && a.kind === 'firewall.block'),
    ).toBe(true);
    expect(await status(api.runs.cancel(runId))).toBe(409);
    expect(await status(api.playbooks.startRun('nope', fakeId(ID_KIND.alert, 1), false))).toBe(404);
    expect(
      await status(api.playbooks.startRun('phishing-triage', fakeId(ID_KIND.alert, 9999), false)),
    ).toBe(404);
  });

  it('expires approvals past their deadline (409 on decision)', async () => {
    let now = TEST_NOW;
    const server = new FakeSpineServer({ now: () => now });
    server.signInAs(DEMO_USERS.analyst.email);
    const api = createSpineApi(new HttpClient({ fetch: server.fetch }));
    await api.auth.refresh();
    now += 4 * 60_000; // approval #2 expired after 3 minutes
    expect(
      await status(api.approvals.decide(fakeId(ID_KIND.approval, 2), { decision: 'approve' })),
    ).toBe(409);
    expect((await api.approvals.list({ status: 'expired' })).items).toHaveLength(1);
  });

  it('manages users with validation and self-protection', async () => {
    const { api } = backend('admin');
    await api.auth.refresh();
    expect(
      await status(
        api.users.create({
          email: 'x@spine.local',
          displayName: 'X',
          role: 'viewer',
          password: 'short',
        }),
      ),
    ).toBe(400);
    expect(await status(api.users.update(DEMO_USERS.admin.id, { role: 'viewer' }))).toBe(409);
    expect(await status(api.users.update(fakeId(ID_KIND.user, 999), { role: 'viewer' }))).toBe(404);
    await expect(
      api.users.update(DEMO_USERS.viewer.id, { displayName: 'Valerie' }),
    ).resolves.toMatchObject({ displayName: 'Valerie' });
    expect(await status(api.playbooks.setEnabled('nope', true))).toBe(404);
    expect(
      await status(
        api.http.request({
          method: 'PATCH',
          path: '/playbooks/phishing-triage',
          body: {},
          schema: null,
        }),
      ),
    ).toBe(400);
  });

  it('records mutating requests in the audit log', async () => {
    const { api, server } = backend('admin');
    await api.auth.refresh();
    await api.playbooks.setEnabled('phishing-triage', false);
    expect(server.db.audit[0]).toMatchObject({
      action: 'PATCH /api/v1/playbooks/:id',
      targetId: 'phishing-triage',
      outcomeStatus: 200,
    });
  });

  it('validates playbook sources (JSON with the schema, YAML structurally)', async () => {
    const { api } = backend('analyst');
    await api.auth.refresh();
    const record = await api.playbooks.get('phishing-triage');
    await expect(api.playbooks.validate(record.source, 'yaml')).resolves.toMatchObject({
      valid: true,
    });
    await expect(
      api.playbooks.validate(JSON.stringify(record.definition), 'json'),
    ).resolves.toMatchObject({ valid: true });
    const invalid = await api.playbooks.validate('{', 'json').catch((e: unknown) => e as ApiError);
    expect(invalid).toMatchObject({ status: 422, type: 'playbook-invalid' });
    const badVersion = await api.playbooks
      .validate(record.source.replace('spine/v1', 'spine/v2'), 'yaml')
      .catch((e: unknown) => e as ApiError);
    expect((badVersion as ApiError).errors[0]?.path).toBe('apiVersion');
  });
});

describe('metrics helpers', () => {
  it('computes nearest-rank percentiles and empty stats', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 50)).toBe(5);
    expect(durationStat([])).toEqual({
      count: 0,
      meanSeconds: null,
      p50Seconds: null,
      p90Seconds: null,
    });
    expect(durationStat([30, 10, 20])).toEqual({
      count: 3,
      meanSeconds: 20,
      p50Seconds: 20,
      p90Seconds: 30,
    });
  });
});

describe('yaml emitter', () => {
  it('emits maps, sequences and quoted scalars', () => {
    expect(
      toYaml({
        a: 1,
        b: 'plain text',
        c: 'yes',
        d: ['x', { e: true, f: null }],
        g: [],
        h: {},
        i: '1.5',
      }),
    ).toBe(
      [
        'a: 1',
        'b: plain text',
        'c: "yes"',
        'd:',
        '- x',
        '- e: true',
        '  f: null',
        'g: []',
        'h: {}',
        'i: "1.5"',
        '',
      ].join('\n'),
    );
  });
});

describe('cookie jars', () => {
  it('memory jar stores one user id', () => {
    const jar = memoryCookieJar('u1');
    expect(jar.get()).toBe('u1');
    jar.clear();
    expect(jar.get()).toBeNull();
  });

  it('document jar uses a fake-only cookie and the demo server uses it', () => {
    const jar = documentCookieJar('spine_test_cookie');
    jar.set('user-1');
    expect(jar.get()).toBe('user-1');
    jar.clear();
    expect(jar.get()).toBeNull();
    expect(createDemoServer().cookieJar.get()).toBeNull();
  });
});
