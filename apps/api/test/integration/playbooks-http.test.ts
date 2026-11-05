import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, buildServer, createHarness, USERS, type Harness } from './playbooks-harness.js';

/** HTTP contract of the playbooks module (docs/architecture/api-contract.md). */

let h: Harness;
let app: FastifyInstance;
beforeAll(async () => {
  h = await createHarness();
  app = await buildServer(h.pb);
});
afterAll(async () => {
  await app.close();
  await h.destroy();
});

const yaml = (version: number, extra = '') => `
apiVersion: spine/v1
kind: Playbook
metadata: { id: http-demo, name: HTTP demo, version: ${version} }
start: gate
steps:
  - id: gate
    type: approval
    with: { prompt: 'Proceed with {{alert.title}}?', approverRole: ${extra || 'analyst'} }
    next: tell
  - id: tell
    type: notify
    with: { channel: '#soc', template: 'done' }
`;

describe('playbook catalog routes', () => {
  it('lists the seeded playbooks and returns one with its definition', async () => {
    const list = await app.inject({ url: '/api/v1/playbooks', headers: bearer('viewer-token') });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ id: string }[]>().map((p) => p.id)).toEqual([
      'brute-force-response',
      'malware-containment',
      'phishing-triage',
    ]);
    const one = await app.inject({
      url: '/api/v1/playbooks/malware-containment?version=1',
      headers: bearer('viewer-token'),
    });
    expect(one.json()).toMatchObject({ id: 'malware-containment', version: 1, enabled: true });
    expect(one.json().definition.steps).toHaveLength(8);
    const missing = await app.inject({
      url: '/api/v1/playbooks/nope',
      headers: bearer('viewer-token'),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    expect((await app.inject({ url: '/api/v1/playbooks' })).statusCode).toBe(401);
  });

  it('validates source and reports every error as a 422 problem', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/playbooks/validate',
      headers: bearer('analyst-token'),
      payload: { source: yaml(1), format: 'yaml' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ valid: true, definition: { start: 'gate' } });

    const broken = yaml(1)
      .replace('next: tell', 'next: nowhere')
      .replace('start: gate', 'start: tell');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/playbooks/validate',
      headers: bearer('analyst-token'),
      payload: { source: broken, format: 'yaml' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().type).toBe('https://spine.dev/problems/playbook-invalid');
    expect(bad.json().errors).toEqual(
      expect.arrayContaining([
        { path: 'steps[0].next', message: 'references unknown step "nowhere"' },
        { path: 'steps[0]', message: 'step "gate" is unreachable from start "tell"' },
      ]),
    );
    const viewer = await app.inject({
      method: 'POST',
      url: '/api/v1/playbooks/validate',
      headers: bearer('viewer-token'),
      payload: { source: yaml(1), format: 'yaml' },
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('publishes new immutable versions (admin only) and refuses stale versions', async () => {
    const publish = (token: string, version: number, extra = '') =>
      app.inject({
        method: 'POST',
        url: '/api/v1/playbooks',
        headers: bearer(token),
        payload: { source: yaml(version, extra), format: 'yaml' },
      });
    expect((await publish('analyst-token', 1)).statusCode).toBe(403);
    const created = await publish('admin-token', 1);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'http-demo', version: 1, enabled: true });
    expect((await publish('admin-token', 1)).statusCode).toBe(409);
    expect((await publish('admin-token', 2, 'admin')).statusCode).toBe(201);
    expect(
      h.audits.filter((a) => a.action === 'playbook.published').map((a) => a.targetId),
    ).toEqual(['http-demo@1', 'http-demo@2']);
  });

  it('enables and disables the latest version', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/playbooks/http-demo',
      headers: bearer('admin-token'),
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ id: 'http-demo', latestVersion: 2, enabled: false });
    const reenable = await app.inject({
      method: 'PATCH',
      url: '/api/v1/playbooks/http-demo',
      headers: bearer('admin-token'),
      payload: { enabled: true },
    });
    expect(reenable.json().enabled).toBe(true);
  });
});

describe('run and approval routes', () => {
  let runId = '';
  let approvalId = '';

  it('starts a manual run (404 for an unknown alert)', async () => {
    const snapshot = h.alert();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/playbooks/http-demo/runs',
      headers: bearer('analyst-token'),
      payload: { alertId: snapshot.alert.id },
    });
    expect(res.statusCode).toBe(202);
    runId = res.json().runId;
    expect(h.queue.jobs).toContainEqual({ runId, seq: 1 });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/playbooks/http-demo/runs',
      headers: bearer('analyst-token'),
      payload: { alertId: '0190f0a0-0000-7000-8000-0000000000ee' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('lists runs with filters and cursor pagination, and shows run detail', async () => {
    const outcome = await h.run(runId);
    expect(outcome.outcome.kind).toBe('waiting_approval');
    const list = await app.inject({
      url: '/api/v1/runs?playbookId=http-demo&limit=1',
      headers: bearer('viewer-token'),
    });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({
      id: runId,
      status: 'waiting_approval',
      trigger: 'manual',
      playbookVersion: 2,
    });

    const detail = await app.inject({
      url: `/api/v1/runs/${runId}`,
      headers: bearer('viewer-token'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ events: { type: string }[] }>().events.map((e) => e.type)).toEqual([
      'run.started',
      'step.started',
      'approval.requested',
    ]);
    expect(detail.json<{ steps: { status: string }[] }>().steps.map((s) => s.status)).toEqual([
      'waiting',
      'pending',
    ]);

    // Paginate through all runs one by one.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof app.inject>> = await app.inject({
        url: `/api/v1/runs?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        headers: bearer('viewer-token'),
      });
      seen.push(...page.json<{ items: { id: string }[] }>().items.map((r) => r.id));
      cursor = page.json().nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(runId);
    const badCursor = await app.inject({
      url: '/api/v1/runs?cursor=garbage',
      headers: bearer('viewer-token'),
    });
    expect(badCursor.statusCode).toBe(400);
  });

  it('lists pending approvals and enforces the approver role', async () => {
    const res = await app.inject({
      url: '/api/v1/approvals?status=pending',
      headers: bearer('viewer-token'),
    });
    const mine = res
      .json<{ items: { id: string; runId: string; prompt: string }[] }>()
      .items.find((a) => a.runId === runId)!;
    expect(mine).toMatchObject({
      status: 'pending',
      approverRole: 'admin',
      playbookId: 'http-demo',
    });
    expect(mine.prompt).toBe('Proceed with Emotet loader executed?');
    approvalId = mine.id;

    const asAnalyst = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${approvalId}/decision`,
      headers: bearer('analyst-token'),
      payload: { decision: 'approve' },
    });
    expect(asAnalyst.statusCode).toBe(403);
  });

  it('records a decision once; a second decision is a 409', async () => {
    const decide = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/approvals/${approvalId}/decision`,
        headers: bearer('admin-token'),
        payload: { decision: 'approve', comment: 'ok' },
      });
    const first = await decide();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'approved',
      decidedBy: USERS['admin-token']!.id,
      comment: 'ok',
    });
    expect((await decide()).statusCode).toBe(409);
    expect((await h.run(runId)).outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
  });

  it('lists simulated actions by kind', async () => {
    const res = await app.inject({
      url: '/api/v1/simulated-actions?kind=chat.post',
      headers: bearer('viewer-token'),
    });
    expect(res.statusCode).toBe(200);
    const mine = res.json<{ items: { runId: string }[] }>().items.filter((a) => a.runId === runId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: 'chat.post',
      stepId: 'tell',
      dryRun: false,
      request: { channel: '#soc', message: 'done' },
    });
  });

  it('cancels unfinished runs (409 once finished)', async () => {
    const done = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers: bearer('analyst-token'),
    });
    expect(done.statusCode).toBe(409);

    const snapshot = h.alert();
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/playbooks/http-demo/runs',
      headers: bearer('analyst-token'),
      payload: { alertId: snapshot.alert.id, dryRun: false },
    });
    const id = started.json().runId;
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${id}/cancel`,
      headers: bearer('analyst-token'),
    });
    expect(cancel.statusCode).toBe(202);
    expect(cancel.json()).toMatchObject({ id, status: 'cancelled' });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/0190f0a0-0000-7000-8000-0000000000ee/cancel',
      headers: bearer('analyst-token'),
    });
    expect(missing.statusCode).toBe(404);
  });
});
