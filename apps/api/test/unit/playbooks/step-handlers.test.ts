import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildEvaluationContext,
  parsePlaybook,
  reduce,
  type RunEventRecord,
  type StepContext,
} from '@spine/playbook-engine';
import { PlaybookDefinitionSchema, type Step } from '@spine/shared-schema';
import { describe, expect, it } from 'vitest';
import type { ResponseActions } from '../../../src/modules/playbooks/application/ports.js';
import { createStepHandlers } from '../../../src/modules/playbooks/application/step-handlers.js';
import { matchesTrigger } from '../../../src/modules/playbooks/domain/trigger.js';
import { enrichmentFixture, scoreFixture, snapshotFixture } from './fixtures.js';

const RUN_ID = '0190f0a0-0000-7000-8000-0000000000aa';

function stepOf(raw: Record<string, unknown>): Step {
  const def = PlaybookDefinitionSchema.parse({
    apiVersion: 'spine/v1',
    kind: 'Playbook',
    metadata: { id: 'demo', name: 'Demo', version: 1 },
    start: String(raw.id),
    steps: [raw],
  });
  return def.steps[0]!;
}

function context(options: { dryRun?: boolean; alert?: boolean } = {}): StepContext {
  const snapshot = snapshotFixture();
  const def = PlaybookDefinitionSchema.parse({
    apiVersion: 'spine/v1',
    kind: 'Playbook',
    metadata: { id: 'demo', name: 'Demo', version: 1 },
    start: 'x',
    steps: [{ id: 'x', type: 'score' }],
  });
  const started: RunEventRecord = {
    seq: 1,
    type: 'run.started',
    stepId: null,
    payload: {
      ...snapshot,
      playbookId: 'demo',
      playbookVersion: 1,
      alertId: snapshot.alert.id,
      dryRun: options.dryRun ?? false,
      trigger: 'manual',
      startedBy: null,
    },
    occurredAt: '2026-10-28T10:00:00.000Z',
  };
  return {
    runId: RUN_ID,
    alert: options.alert === false ? null : snapshot.alert,
    dryRun: options.dryRun ?? false,
    signal: new AbortController().signal,
    idempotencyKey: `${RUN_ID}:x:1`,
    attempt: 1,
    input: buildEvaluationContext(RUN_ID, reduce(def, [started])),
  };
}

function harness() {
  const calls: { port: string; request: unknown; dryRun: boolean }[] = [];
  const record = (port: string) => (request: unknown, options: { dryRun: boolean }) => {
    calls.push({ port, request, dryRun: options.dryRun });
  };
  const actions: ResponseActions = {
    firewall: {
      block: (req, o) => (
        record('block')(req, o),
        Promise.resolve({ blockId: 'FW-1', blocked: req.indicators, expiresAt: 'later' })
      ),
      unblock: (req, o) => (
        record('unblock')(req, o),
        Promise.resolve({ blockId: req.blockId, unblocked: req.indicators })
      ),
    },
    ticketing: {
      create: (req, o) => (record('ticket')(req, o), Promise.resolve({ ticketId: 'SIM-1000' })),
      close: (req, o) => (
        record('close')(req, o),
        Promise.resolve({ ticketId: req.ticketId, closed: true })
      ),
    },
    chat: { post: (req, o) => (record('chat')(req, o), Promise.resolve({ messageId: 'MSG-1' })) },
    statusPreview: {
      record: (req, o) => (
        record('preview')(req, o),
        Promise.resolve({ previewed: true as const })
      ),
    },
  };
  const statusCalls: string[] = [];
  const handlers = createStepHandlers({
    gateways: {
      enrichment: {
        enrich: () => Promise.resolve([enrichmentFixture('203.0.113.7', 'ipv4', 'benign')]),
      },
      scoring: { score: (_a, _e, o) => Promise.resolve(o.persist ? scoreFixture(42) : null) },
      alertStatus: {
        setStatus: (_id, status) => {
          statusCalls.push(status);
          return Promise.resolve({ changed: true });
        },
      },
    },
    actions,
    approvals: {
      createIfMissing: (a) =>
        Promise.resolve({
          ...a,
          status: 'pending',
          decidedAt: null,
          decidedBy: null,
          comment: null,
        }),
    },
    clock: { now: () => new Date('2026-10-28T10:00:00.000Z') },
    ids: { next: () => '0190f0a0-0000-7000-8000-0000000000ff' },
  });
  return { handlers, calls, statusCalls };
}

describe('step handlers', () => {
  it('enrich merges fresh results over the snapshot, per provider and indicator', async () => {
    const { handlers } = harness();
    const out = (await handlers.enrich!.execute(
      stepOf({ id: 'e', type: 'enrich' }),
      context(),
    )) as {
      enrichments: { verdict: string; indicator: { value: string } }[];
      refreshed: number;
    };
    expect(out.refreshed).toBe(1);
    expect(out.enrichments).toHaveLength(3);
    expect(out.enrichments.find((r) => r.indicator.value === '203.0.113.7')?.verdict).toBe(
      'benign',
    );
  });

  it('score persists outside dry runs and keeps the snapshot score when scoring is unavailable', async () => {
    const { handlers } = harness();
    const step = stepOf({ id: 's', type: 'score' });
    expect(await handlers.score!.execute(step, context())).toMatchObject({ score: { score: 42 } });
    expect(await handlers.score!.execute(step, context({ dryRun: true }))).toMatchObject({
      score: { score: 90 },
    });
  });

  it('set_status changes the alert, or only records a preview in dry runs', async () => {
    const { handlers, calls, statusCalls } = harness();
    const step = stepOf({ id: 'st', type: 'set_status', with: { status: 'triaged' } });
    expect(await handlers.set_status!.execute(step, context())).toEqual({
      status: 'triaged',
      changed: true,
    });
    expect(await handlers.set_status!.execute(step, context({ dryRun: true }))).toEqual({
      dryRun: true,
      wouldSetStatus: 'triaged',
    });
    expect(statusCalls).toEqual(['triaged']);
    expect(calls.map((c) => c.port)).toEqual(['preview']);
  });

  it('notify renders its template from the evaluation context', async () => {
    const { handlers, calls } = harness();
    const step = stepOf({
      id: 'n',
      type: 'notify',
      with: {
        channel: '#soc',
        template: '{{alert.title}} / {{score.score}} / {{enrichment.malicious}}',
      },
    });
    const out = await handlers.notify!.execute(step, context());
    expect(out).toMatchObject({
      messageId: 'MSG-1',
      message: 'Emotet loader executed / 90 / 203.0.113.7',
    });
    expect(calls[0]?.request).toEqual({
      channel: '#soc',
      message: 'Emotet loader executed / 90 / 203.0.113.7',
    });
  });

  it('create_ticket uses a default summary and close_ticket compensates it', async () => {
    const { handlers, calls } = harness();
    const step = stepOf({
      id: 't',
      type: 'create_ticket',
      with: { queue: 'SOC' },
      compensate: { type: 'close_ticket' },
    });
    const out = await handlers.create_ticket!.execute(step, context());
    expect(out).toMatchObject({
      ticketId: 'SIM-1000',
      summary: '[malware] Emotet loader executed',
    });
    expect(await handlers.create_ticket!.compensate!(step, context(), out)).toEqual({
      ticketId: 'SIM-1000',
      closed: true,
    });
    expect(await handlers.create_ticket!.compensate!(step, context(), null)).toEqual({
      closed: false,
      reason: 'no ticket was created',
    });
    expect(calls.map((c) => c.port)).toEqual(['ticket', 'close']);
  });

  it('block_indicator blocks only qualifying indicators, and unblocks them on compensation', async () => {
    const { handlers, calls } = harness();
    const step = stepOf({
      id: 'b',
      type: 'block_indicator',
      with: { minVerdict: 'malicious' },
      compensate: { type: 'unblock_indicator' },
    });
    const out = await handlers.block_indicator!.execute(step, context());
    expect(out).toMatchObject({
      blockId: 'FW-1',
      blocked: [{ type: 'ipv4', value: '203.0.113.7' }],
    });
    await handlers.block_indicator!.compensate!(step, context(), out);
    expect(calls.map((c) => c.port)).toEqual(['block', 'unblock']);
    expect(
      await handlers.block_indicator!.compensate!(step, context(), { blockId: null }),
    ).toMatchObject({ unblocked: [] });
  });

  it('block_indicator does not call the firewall when nothing qualifies', async () => {
    const { handlers, calls } = harness();
    const step = stepOf({ id: 'b', type: 'block_indicator', with: { indicatorTypes: ['url'] } });
    const out = await handlers.block_indicator!.execute(step, context());
    expect(out).toMatchObject({ blockId: null, blocked: [] });
    expect(calls).toEqual([]);
  });

  it('approval creates (or finds) the approval record with a rendered prompt and deadline', async () => {
    const { handlers } = harness();
    const step = stepOf({
      id: 'a',
      type: 'approval',
      with: { prompt: 'Block {{alert.network.sourceIp}}?', expiresInMs: 600_000 },
    });
    expect(await handlers.approval!.execute(step, context())).toEqual({
      approvalId: '0190f0a0-0000-7000-8000-0000000000ff',
      expiresAt: '2026-10-28T10:10:00.000Z',
      prompt: 'Block 203.0.113.7?',
      approverRole: 'analyst',
      onTimeout: 'reject',
    });
  });

  it('rejects steps without an alert snapshot, or of the wrong type', async () => {
    const { handlers } = harness();
    await expect(
      handlers.enrich!.execute(stepOf({ id: 'e', type: 'enrich' }), context({ alert: false })),
    ).rejects.toThrow(/no alert snapshot/);
    await expect(
      handlers.enrich!.execute(stepOf({ id: 's', type: 'score' }), context()),
    ).rejects.toThrow(/handler for enrich got score/);
  });
});

describe('shipped playbooks (config/playbooks)', () => {
  const dir = path.resolve(import.meta.dirname, '../../../config/playbooks');

  it('are all valid', async () => {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml'));
    expect(files.sort()).toEqual([
      'brute-force-response.yaml',
      'malware-containment.yaml',
      'phishing-triage.yaml',
    ]);
    for (const file of files) {
      const result = parsePlaybook(await readFile(path.join(dir, file), 'utf8'), 'yaml');
      expect(result.valid ? [] : result.errors, file).toEqual([]);
    }
  });

  it('trigger on the intended alerts', async () => {
    const load = async (name: string) => {
      const result = parsePlaybook(await readFile(path.join(dir, `${name}.yaml`), 'utf8'), 'yaml');
      if (!result.valid) throw new Error(name);
      return result.definition;
    };
    const malware = await load('malware-containment');
    const phishing = await load('phishing-triage');
    const brute = await load('brute-force-response');
    expect(matchesTrigger(malware, snapshotFixture({ score: 65 }))).toBe(true);
    expect(matchesTrigger(malware, snapshotFixture({ score: 30 }))).toBe(false);
    expect(
      matchesTrigger(phishing, snapshotFixture({ alert: { category: 'phishing' }, score: 10 })),
    ).toBe(true);
    expect(
      matchesTrigger(
        brute,
        snapshotFixture({ alert: { category: 'credential_access' }, score: 45 }),
      ),
    ).toBe(true);
    expect(
      matchesTrigger(
        brute,
        snapshotFixture({ alert: { category: 'credential_access' }, score: 20 }),
      ),
    ).toBe(false);
  });
});
