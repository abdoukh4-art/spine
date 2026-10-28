import { reduce } from '@spine/playbook-engine';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatPort } from '../../src/modules/playbooks/application/ports.js';
import { createHarness, type Harness } from './playbooks-harness.js';

/**
 * Durable execution over real Postgres (ADR-0010, ADR-0021): the engine, the Postgres
 * RunStore with its projection and outbox, the simulated adapters and the use cases.
 * The queue is recorded instead of Redis; playbooks-queue.test.ts covers BullMQ.
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.destroy();
});

async function publishPlaybook(source: object): Promise<void> {
  await h.pb.catalog.publish(JSON.stringify(source), 'json', {
    id: '0190f0a0-0000-7000-8000-00000000000c',
  });
}

const playbook = (id: string, steps: object[], start = 'a') => ({
  apiVersion: 'spine/v1',
  kind: 'Playbook',
  metadata: { id, name: id, version: 1 },
  start,
  steps,
});

async function actions(runId: string, kind?: string) {
  let query = h.t.db.selectFrom('simulated_actions').selectAll().where('run_id', '=', runId);
  if (kind) query = query.where('kind', '=', kind);
  return query.orderBy('created_at').orderBy('id').execute();
}

async function eventTypes(runId: string): Promise<string[]> {
  const detail = await h.pb.runs.detail(runId);
  return detail.events.map((e) => (e.stepId ? `${e.type}:${e.stepId}` : e.type));
}

async function startManual(playbookId: string, alertId: string, dryRun = false): Promise<string> {
  return h.pb.runs.startManual({
    playbookId,
    alertId,
    dryRun,
    actorId: '0190f0a0-0000-7000-8000-00000000000b',
  });
}

describe('automatic runs from alert.scored', () => {
  it('runs phishing-triage end to end: outbox → trigger → run → simulated actions', async () => {
    const snapshot = h.alert({ category: 'phishing', score: 30 });
    snapshot.enrichments = snapshot.enrichments.filter((e) => e.verdict !== 'suspicious');
    await h.publish('alert.scored', snapshot.alert.id, {
      alert: snapshot.alert,
      enrichments: snapshot.enrichments,
      score: snapshot.score!,
    });
    await h.drainOutbox();

    const runs = await h.pb.runs.forAlert(snapshot.alert.id);
    expect(runs.map((r) => [r.playbookId, r.trigger, r.status])).toEqual([
      ['phishing-triage', 'auto', 'pending'],
    ]);
    const runId = runs[0]!.id;
    expect(h.queue.jobs).toContainEqual({ runId, seq: 1 });

    const result = await h.run(runId);
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    // A malicious IP but no malicious or suspicious URL/domain/email → mark-triaged path.
    expect(h.statusChanges).toContainEqual([snapshot.alert.id, 'triaged']);
    const chat = await actions(runId, 'chat.post');
    expect(chat).toHaveLength(1);
    expect(chat[0]?.idempotency_key).toBe(`${runId}:notify-benign:1`);
    expect((await h.pb.runs.summary(runId)).status).toBe('succeeded');
  });

  it('is idempotent: redelivering alert.scored creates no second run', async () => {
    const snapshot = h.alert({ category: 'phishing' });
    const payload = {
      alert: snapshot.alert,
      enrichments: snapshot.enrichments,
      score: snapshot.score!,
    };
    await h.pb.runs.triggerForScoredAlert(payload);
    expect(await h.pb.runs.triggerForScoredAlert(payload)).toEqual([]);
    expect(await h.pb.runs.forAlert(snapshot.alert.id)).toHaveLength(1);
  });

  it('starts nothing for disabled playbooks or non-matching alerts', async () => {
    const low = h.alert({ category: 'malware', score: 10 });
    expect(await h.pb.runs.triggerForScoredAlert(low)).toEqual([]);
    await h.pb.catalog.setEnabled('phishing-triage', false, { id: 'x' });
    expect(await h.pb.runs.triggerForScoredAlert(h.alert({ category: 'phishing' }))).toEqual([]);
    await h.pb.catalog.setEnabled('phishing-triage', true, { id: 'x' });
  });
});

describe('seeding', () => {
  it('skips invalid playbook files, reports them, and never re-inserts stored versions', async () => {
    const result = await h.pb.catalog.seed([
      { name: 'broken.yaml', source: 'apiVersion: [', format: 'yaml' },
      {
        name: 'again.json',
        source: JSON.stringify(
          playbook('seed-demo', [
            { id: 'a', type: 'notify', with: { channel: '#c', template: 'x' } },
          ]),
        ),
        format: 'json',
      },
    ]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]).toMatch(/^broken\.yaml: /);
    expect(result.inserted).toEqual(['seed-demo@1']);
    const again = await h.pb.catalog.seed([
      {
        name: 'again.json',
        source: JSON.stringify(
          playbook('seed-demo', [
            { id: 'a', type: 'notify', with: { channel: '#c', template: 'x' } },
          ]),
        ),
        format: 'json',
      },
    ]);
    expect(again.inserted).toEqual([]);
  });
});

describe('approval gates', () => {
  async function waitingMalwareRun(): Promise<{ runId: string; approvalId: string }> {
    const snapshot = h.alert({ category: 'malware', score: 92 });
    const [runId] = await h.pb.runs.triggerForScoredAlert(snapshot);
    const result = await h.run(runId!);
    if (result.outcome.kind !== 'waiting_approval') throw new Error(JSON.stringify(result.outcome));
    return { runId: runId!, approvalId: result.outcome.approvalId };
  }

  it('approve: blocks, opens a ticket and notifies; the decision is audited and re-enqueued', async () => {
    const { runId, approvalId } = await waitingMalwareRun();
    expect((await h.pb.runs.summary(runId)).status).toBe('waiting_approval');
    const analyst = { id: '0190f0a0-0000-7000-8000-00000000000b', role: 'analyst' as const };
    const approval = await h.pb.approvals.decide(
      approvalId,
      { decision: 'approve', comment: 'go' },
      analyst,
    );
    expect(approval).toMatchObject({ status: 'approved', decidedBy: analyst.id, comment: 'go' });
    expect(h.audits.at(-1)).toMatchObject({ action: 'approval.decided', targetId: approvalId });
    const lastSeq = (await h.pb.runs.detail(runId)).events.length;
    expect(h.queue.jobs).toContainEqual({ runId, seq: lastSeq });
    // The outbox path (approval.decided → resume subscriber) enqueues the same job again.
    const before = h.queue.jobs.length;
    await h.drainOutbox();
    expect(h.queue.jobs.slice(before)).toContainEqual({ runId, seq: lastSeq });

    expect((await h.run(runId)).outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect((await actions(runId)).map((a) => a.kind)).toEqual([
      'firewall.block',
      'ticket.create',
      'chat.post',
    ]);
    const block = (await actions(runId, 'firewall.block'))[0]!;
    expect(block.response).toMatchObject({ blocked: [{ type: 'ipv4', value: '203.0.113.7' }] });
    const detail = await h.pb.runs.detail(runId);
    expect(detail.steps.find((s) => s.stepId === 'ticket')?.output).toMatchObject({
      ticketId: expect.stringMatching(/^SIM-\d+$/),
    });

    await expect(
      h.pb.approvals.decide(approvalId, { decision: 'reject' }, analyst),
    ).rejects.toThrow(/already approved/);
  });

  it('reject: follows onReject, nothing is blocked', async () => {
    const { runId, approvalId } = await waitingMalwareRun();
    await h.pb.approvals.decide(
      approvalId,
      { decision: 'reject' },
      { id: '0190f0a0-0000-7000-8000-00000000000b', role: 'analyst' },
    );
    expect((await h.run(runId)).outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(await eventTypes(runId)).toContain('approval.rejected:approve-block');
    expect((await actions(runId)).map((a) => a.kind)).toEqual(['chat.post']);
  });

  it('expiry: the sweeper applies onTimeout (reject) and the run continues', async () => {
    const snapshot = h.alert({ category: 'credential_access', score: 80 });
    const [runId] = await h.pb.runs.triggerForScoredAlert(snapshot);
    expect((await h.run(runId!)).outcome.kind).toBe('waiting_approval');
    expect(await h.pb.approvals.expireDue()).toBe(0);
    h.clock.advance(16 * 60_000);
    expect(await h.pb.approvals.expireDue()).toBe(1);
    const approvals = await h.pb.approvals.list({ status: 'expired', limit: 50 });
    expect(approvals.items.some((a) => a.runId === runId)).toBe(true);
    expect(await eventTypes(runId!)).toContain('approval.rejected:approve-block');
    expect((await h.run(runId!)).outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect((await actions(runId!)).map((a) => a.kind)).toEqual(['chat.post']);
  });

  it('cancel: stops a waiting run and expires its approval; cancelling twice is a conflict', async () => {
    const { runId, approvalId } = await waitingMalwareRun();
    const summary = await h.pb.runs.cancel(runId, { id: 'someone' });
    expect(summary.status).toBe('cancelled');
    expect((await h.pb.store.approvals.get(approvalId))?.status).toBe('expired');
    expect((await h.run(runId)).outcome).toEqual({ kind: 'terminal', status: 'cancelled' });
    await expect(h.pb.runs.cancel(runId, { id: 'someone' })).rejects.toThrow(/already cancelled/);
  });
});

describe('failures, retries and compensation', () => {
  it('retries a failing step with backoff, then succeeds with a new attempt key', async () => {
    await publishPlaybook(
      playbook('flaky-notify', [
        {
          id: 'a',
          type: 'notify',
          retry: { maxAttempts: 3, backoffMs: 200 },
          with: { channel: '#c', template: 'hi' },
        },
      ]),
    );
    const snapshot = h.alert();
    const runId = await startManual('flaky-notify', snapshot.alert.id);
    h.faults.failureRateByKind['chat.post'] = 0.5;
    h.faults.randoms.push(0.1); // first attempt: outage; later: 0.99 → success
    const first = await h.pb.executor.advanceRun(runId);
    expect(first.outcome).toMatchObject({ kind: 'retry_scheduled', delayMs: 200 });
    expect(h.queue.jobs.at(-1)).toEqual({ runId, seq: first.lastSeq, delayMs: 200 });
    h.clock.advance(200);
    expect((await h.pb.executor.advanceRun(runId)).outcome).toEqual({
      kind: 'terminal',
      status: 'succeeded',
    });
    delete h.faults.failureRateByKind['chat.post'];

    expect(await eventTypes(runId)).toEqual([
      'run.started',
      'step.started:a',
      'step.failed:a',
      'step.retry_scheduled:a',
      'step.started:a',
      'step.succeeded:a',
      'run.succeeded',
    ]);
    const chat = await actions(runId, 'chat.post');
    expect(chat.map((c) => c.idempotency_key)).toEqual([`${runId}:a:2`]);
  });

  it('compensates a completed block when a later step fails for good: block then unblock', async () => {
    await publishPlaybook(
      playbook('block-then-ticket', [
        {
          id: 'a',
          type: 'block_indicator',
          with: { indicatorTypes: ['ipv4'] },
          compensate: { type: 'unblock_indicator' },
          next: 'b',
        },
        { id: 'b', type: 'create_ticket', with: { queue: 'SOC' } },
      ]),
    );
    const snapshot = h.alert();
    const runId = await startManual('block-then-ticket', snapshot.alert.id);
    h.faults.failureRateByKind['ticket.create'] = 1;
    const result = await h.run(runId);
    delete h.faults.failureRateByKind['ticket.create'];

    expect(result.outcome).toEqual({ kind: 'terminal', status: 'compensated' });
    expect((await actions(runId)).map((a) => a.kind)).toEqual([
      'firewall.block',
      'firewall.unblock',
    ]);
    const [block, unblock] = await actions(runId);
    expect(unblock?.request).toMatchObject({ blockId: block?.response.blockId });
    expect(unblock?.idempotency_key).toBe(`${runId}:a:compensate`);
    const detail = await h.pb.runs.detail(runId);
    expect(detail.steps.map((s) => [s.stepId, s.status])).toEqual([
      ['a', 'compensated'],
      ['b', 'failed'],
    ]);
  });
});

describe('durability', () => {
  it('crash/resume: a step started but never finished completes once, with one side effect', async () => {
    await publishPlaybook(
      playbook('crashy', [
        { id: 'a', type: 'block_indicator', with: { indicatorTypes: ['ipv4'] }, next: 'b' },
        { id: 'b', type: 'notify', with: { channel: '#c', template: 'done' } },
      ]),
    );
    const snapshot = h.alert();
    const runId = await startManual('crashy', snapshot.alert.id);
    const key = `${runId}:a:1`;
    // A previous worker appended step.started and died mid-step…
    await h.pb.store.runs.append(runId, 1, [
      {
        seq: 2,
        type: 'step.started',
        stepId: 'a',
        payload: { attempt: 1, idempotencyKey: key },
        occurredAt: h.clock.now().toISOString(),
      },
    ]);
    expect((await h.pb.runs.summary(runId)).status).toBe('running');
    // …after the firewall had already applied the block.
    const applied = await h.real.firewall.block(
      {
        indicators: [{ type: 'ipv4', value: '203.0.113.7' }],
        durationMinutes: 1440,
        alertId: snapshot.alert.id,
      },
      {
        idempotencyKey: key,
        runId,
        stepId: 'a',
        dryRun: false,
        signal: new AbortController().signal,
      },
    );
    const result = await h.run(runId);
    expect(result.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    const again = await h.run(runId);
    expect(again.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });

    const blocks = await actions(runId, 'firewall.block');
    expect(blocks.map((b) => b.idempotency_key)).toEqual([key]);
    const detail = await h.pb.runs.detail(runId);
    expect(detail.steps.find((s) => s.stepId === 'a')?.output).toMatchObject({
      blockId: applied.blockId,
    });
    const types = await eventTypes(runId);
    expect(types.filter((t) => t === 'step.started:a')).toHaveLength(1);
    expect(types.filter((t) => t === 'step.succeeded:a')).toHaveLength(1);
  });

  it('dry-run: skips the approval and records only dry-run simulated actions', async () => {
    const snapshot = h.alert({ category: 'malware', score: 95 });
    const runId = await startManual('malware-containment', snapshot.alert.id, true);
    expect((await h.run(runId)).outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(await eventTypes(runId)).toContain('step.skipped:approve-block');
    const all = await actions(runId);
    expect(all.map((a) => a.kind)).toEqual(['firewall.block', 'ticket.create', 'chat.post']);
    expect(all.every((a) => a.dry_run)).toBe(true);
    expect((await h.pb.approvals.list({ limit: 200 })).items.some((a) => a.runId === runId)).toBe(
      false,
    );
  });

  it('optimistic concurrency: two concurrent advances of one run produce one log and one effect per step', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const keys: string[] = [];
    const racing = await createHarness({
      actions: (real) => ({
        ...real,
        chat: {
          post: async (req, options): ReturnType<ChatPort['post']> => {
            keys.push(options.idempotencyKey);
            calls += 1;
            if (calls === 1)
              await gate; // worker A waits inside step "a"…
            else release(); // …until worker B arrives at the same step
            return real.chat.post(req, options);
          },
        },
      }),
    });
    try {
      await racing.pb.catalog.publish(
        JSON.stringify(
          playbook('race', [
            { id: 'a', type: 'notify', with: { channel: '#c', template: '1' }, next: 'b' },
            { id: 'b', type: 'notify', with: { channel: '#c', template: '2' } },
          ]),
        ),
        'json',
        { id: '0190f0a0-0000-7000-8000-00000000000c' },
      );
      const snapshot = racing.alert();
      const runId = await racing.pb.runs.startManual({
        playbookId: 'race',
        alertId: snapshot.alert.id,
        dryRun: false,
        actorId: '0190f0a0-0000-7000-8000-00000000000b',
      });
      const workerA = racing.pb.executor.advanceRun(runId);
      await expect.poll(() => calls).toBe(1);
      const [a, b] = await Promise.all([workerA, racing.pb.executor.advanceRun(runId)]);

      expect(a.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
      expect(b.outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
      expect(a.conflicts + b.conflicts).toBeGreaterThanOrEqual(1);
      expect(keys.slice(0, 2)).toEqual([`${runId}:a:1`, `${runId}:a:1`]);
      const detail = await racing.pb.runs.detail(runId);
      expect(detail.events.map((e) => e.seq)).toEqual(detail.events.map((_e, i) => i + 1));
      expect(detail.events.filter((e) => e.type === 'step.succeeded').map((e) => e.stepId)).toEqual(
        ['a', 'b'],
      );
      const rows = await racing.t.db
        .selectFrom('simulated_actions')
        .select('step_id')
        .where('run_id', '=', runId)
        .execute();
      expect(rows.map((r) => r.step_id).sort()).toEqual(['a', 'b']);
    } finally {
      await racing.destroy();
    }
  });

  it('keeps the playbook_runs projection equal to a rebuild from the events', async () => {
    const runs = await h.t.db.selectFrom('playbook_runs').select('id').execute();
    expect(runs.length).toBeGreaterThan(5);
    for (const { id } of runs) {
      const loaded = await h.pb.store.runs.load(id);
      const state = reduce(loaded!.definition, loaded!.events);
      const summary = await h.pb.runs.summary(id);
      expect([
        summary.status,
        summary.currentStepId,
        summary.startedAt,
        summary.finishedAt,
      ]).toEqual([state.status, state.currentStepId, state.startedAt, state.finishedAt]);
      const row = await h.t.db
        .selectFrom('playbook_runs')
        .select(['last_seq', 'approval_wait_ms'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect([row.last_seq, Number(row.approval_wait_ms)]).toEqual([
        state.lastSeq,
        state.approvalWaitMs,
      ]);
    }
  });

  it('publishes playbook.run.finished and approval events through the outbox', async () => {
    const rows = await sql<{ type: string; n: string }>`
      select type, count(*)::text as n from domain_events where type like 'playbook.%' or type like 'approval.%' group by type`.execute(
      h.t.db,
    );
    const counts = Object.fromEntries(rows.rows.map((r) => [r.type, Number(r.n)]));
    expect(counts['playbook.run.requested']).toBeGreaterThan(0);
    expect(counts['playbook.run.finished']).toBeGreaterThan(0);
    expect(counts['approval.requested']).toBeGreaterThan(0);
    expect(counts['approval.decided']).toBeGreaterThan(0);
  });
});
