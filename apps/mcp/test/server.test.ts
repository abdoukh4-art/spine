import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMcpConfig } from '../src/config.js';
import { createSpineMcpServer } from '../src/server.js';
import { SpineClient } from '../src/spine-client.js';
import { UNTRUSTED_MAX_CHARS } from '../src/views.js';
import {
  ALERT_ID,
  INJECTION,
  RUN_ID,
  alertDetail,
  alertSummary,
  fakeSpine,
  runDetail,
} from './fake-spine.js';

type Routes = Parameters<typeof fakeSpine>[0];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A real MCP client connected in memory to the server, which talks to a fake Spine. */
async function connect(
  routes: Routes,
  opts: { allowLiveRuns?: boolean; expireTokenAfter?: number } = {},
) {
  const spineApi = fakeSpine(
    routes,
    opts.expireTokenAfter === undefined ? {} : { expireTokenAfter: opts.expireTokenAfter },
  );
  const spine = new SpineClient({
    baseUrl: 'http://spine.test',
    email: 'ai-analyst@spine.test',
    password: 'pw',
    timeoutMs: 5_000,
    fetch: spineApi.fetch,
  });
  const server = createSpineMcpServer({ spine, allowLiveRuns: opts.allowLiveRuns ?? false });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientEnd);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, spineApi };
}

function text(result: { content: unknown }): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? '';
}

function json(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

describe('tool surface (the guardrail starts with what is NOT offered)', () => {
  it('exposes the triage tools and nothing that approves, closes or administers', async () => {
    const { client } = await connect({});
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_alert',
      'get_metrics_summary',
      'get_run',
      'list_alerts',
      'list_pending_approvals',
      'list_playbooks',
      'propose_playbook_run',
      'set_alert_status',
    ]);
    for (const t of tools) {
      expect(t.name).not.toMatch(/approve|reject|decide|close|delete|user|publish/);
      expect(t.description?.length ?? 0).toBeGreaterThan(40);
    }
    const reads = tools.filter((t) => t.name.startsWith('get_') || t.name.startsWith('list_'));
    for (const t of reads) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'propose_playbook_run')?.annotations?.destructiveHint).toBe(
      true,
    );
  });
});

describe('reading', () => {
  it('list_alerts forwards filters as Spine query parameters and fences sensor text', async () => {
    const { client, spineApi } = await connect({
      'GET /api/v1/alerts': () => ({
        status: 200,
        body: { items: [alertSummary({ title: INJECTION })], nextCursor: null },
      }),
    });
    const result = await client.callTool({
      name: 'list_alerts',
      arguments: { status: ['new', 'triaged'], minScore: 70, text: 'beacon', sort: 'score' },
    });
    const call = spineApi.calls.find((c) => c.path === '/api/v1/alerts')!;
    expect(call.search.getAll('status')).toEqual(['new', 'triaged']);
    expect(call.search.get('minScore')).toBe('70');
    expect(call.search.get('q')).toBe('beacon');
    expect(call.search.get('sort')).toBe('score');
    expect(call.authorization).toBe('Bearer token-1');
    expect(call.userAgent).toMatch(/^spine-mcp\//);

    const body = json(result) as { notice: string; alerts: { sensorData: { title: string } }[] };
    expect(body.notice).toMatch(/attacker-controlled/);
    const title = body.alerts[0]!.sensorData.title;
    expect(title.length).toBeLessThan(UNTRUSTED_MAX_CHARS + 40);
    expect(title).toMatch(/truncated \d+ chars/);
  });

  it('get_alert explains the score, fences every sensor field, and never forwards the raw payload', async () => {
    const { client } = await connect({
      [`GET /api/v1/alerts/${ALERT_ID}`]: () => ({ status: 200, body: alertDetail() }),
    });
    const result = await client.callTool({ name: 'get_alert', arguments: { alertId: ALERT_ID } });
    const raw = text(result);
    expect(raw).not.toContain('RAW-PAYLOAD-MUST-NOT-REACH-THE-MODEL');
    const body = json(result) as {
      score: { score: number; factors: { rule: string; points: number }[] };
      sensorData: { title: string; description: string; labels: Record<string, string> };
      enrichments: { verdict: string }[];
    };
    expect(body.score.score).toBe(100);
    expect(body.score.factors.map((f) => f.rule)).toEqual(['baseline', 'malicious-indicator']);
    expect(body.enrichments[0]!.verdict).toBe('malicious');
    // The injection is still visible to the model, but only as clipped sensor data.
    expect(body.sensorData.title).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(body.sensorData.title).toMatch(/truncated/);
    expect(body.sensorData.labels.note).toMatch(/truncated/);
    // Nothing outside sensorData repeats the injected text.
    const { sensorData: _ignored, ...trusted } = body;
    expect(JSON.stringify(trusted)).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
  });

  it('get_run, list_playbooks, list_pending_approvals and metrics map Spine responses', async () => {
    const { client } = await connect({
      [`GET /api/v1/runs/${RUN_ID}`]: () => ({ status: 200, body: runDetail() }),
      'GET /api/v1/playbooks': () => ({
        status: 200,
        body: [
          {
            id: 'malware-containment',
            latestVersion: 1,
            name: 'Malware containment',
            description: 'Block, ticket, notify',
            enabled: true,
            stepCount: 5,
            tags: ['malware'],
          },
        ],
      }),
      'GET /api/v1/approvals': (call) => {
        expect(call.search.get('status')).toBe('pending');
        return { status: 200, body: { items: [], nextCursor: null } };
      },
    });
    const run = json(await client.callTool({ name: 'get_run', arguments: { runId: RUN_ID } }));
    expect(run).toMatchObject({ status: 'succeeded', dryRun: true, awaitingHumanApproval: false });
    const playbooks = json(await client.callTool({ name: 'list_playbooks', arguments: {} }));
    expect(playbooks).toMatchObject({ playbooks: [{ id: 'malware-containment', steps: 5 }] });
    const approvals = json(
      await client.callTool({ name: 'list_pending_approvals', arguments: {} }),
    );
    expect(approvals).toMatchObject({ approvals: [] });
  });
});

describe('acting, within limits', () => {
  it('set_alert_status can triage but cannot close an alert', async () => {
    const { client, spineApi } = await connect({
      [`PATCH /api/v1/alerts/${ALERT_ID}`]: (call) => ({
        status: 200,
        body: alertSummary({ status: (call.body as { status: 'triaged' }).status }),
      }),
    });
    const triaged = await client.callTool({
      name: 'set_alert_status',
      arguments: { alertId: ALERT_ID, status: 'triaged' },
    });
    expect(json(triaged)).toEqual({ alertId: ALERT_ID, status: 'triaged' });

    const closing = await client
      .callTool({ name: 'set_alert_status', arguments: { alertId: ALERT_ID, status: 'resolved' } })
      .catch((err: unknown) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
    expect(closing.isError).toBe(true);
    // Rejected before any request reached Spine.
    expect(spineApi.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('propose_playbook_run defaults to a dry run', async () => {
    const { client, spineApi } = await connect({
      'POST /api/v1/playbooks/malware-containment/runs': () => ({
        status: 202,
        body: { runId: RUN_ID },
      }),
    });
    const result = await client.callTool({
      name: 'propose_playbook_run',
      arguments: { playbookId: 'malware-containment', alertId: ALERT_ID },
    });
    expect(json(result)).toMatchObject({ runId: RUN_ID, dryRun: true });
    expect(spineApi.calls.at(-1)?.body).toEqual({ alertId: ALERT_ID, dryRun: true });
  });

  it('refuses a live run unless the operator enabled it, without calling Spine', async () => {
    const routes: Routes = {
      'POST /api/v1/playbooks/malware-containment/runs': () => ({
        status: 202,
        body: { runId: RUN_ID },
      }),
    };
    const off = await connect(routes);
    const refused = await off.client.callTool({
      name: 'propose_playbook_run',
      arguments: { playbookId: 'malware-containment', alertId: ALERT_ID, dryRun: false },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/Live runs are disabled/);
    expect(off.spineApi.calls.some((c) => c.path.endsWith('/runs'))).toBe(false);

    const on = await connect(routes, { allowLiveRuns: true });
    const live = await on.client.callTool({
      name: 'propose_playbook_run',
      arguments: { playbookId: 'malware-containment', alertId: ALERT_ID, dryRun: false },
    });
    expect(json(live)).toMatchObject({ dryRun: false });
    expect(text(live)).toMatch(/cannot approve it yourself/);
  });

  it("returns Spine's refusal to the model as a readable tool error", async () => {
    const { client } = await connect({
      [`PATCH /api/v1/alerts/${ALERT_ID}`]: () => ({
        status: 409,
        body: { title: 'Conflict', detail: 'illegal transition new -> in_progress', status: 409 },
      }),
    });
    const result = await client.callTool({
      name: 'set_alert_status',
      arguments: { alertId: ALERT_ID, status: 'in_progress' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/409.*illegal transition/);
  });
});

describe('Spine client', () => {
  it('logs in again once when the access token expires', async () => {
    const { client, spineApi } = await connect(
      {
        'GET /api/v1/metrics/summary': () => ({
          status: 200,
          body: {
            window: { from: '2026-10-22T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' },
            alertVolume: {
              total: 0,
              bySeverity: { informational: 0, low: 0, medium: 0, high: 0, critical: 0 },
              byDay: [],
            },
            mttd: {
              count: 0,
              meanSeconds: null,
              p50Seconds: null,
              p90Seconds: null,
              clockSkewCount: 0,
            },
            mttr: { count: 0, meanSeconds: null, p50Seconds: null, p90Seconds: null, openCount: 0 },
            playbooks: {
              successRate: null,
              runs: { succeeded: 0, failed: 0, compensated: 0, cancelled: 0, inFlight: 0 },
              latency: { count: 0, meanSeconds: null, p50Seconds: null, p90Seconds: null },
              approvalWait: { count: 0, meanSeconds: null, p50Seconds: null, p90Seconds: null },
            },
          },
        }),
      },
      { expireTokenAfter: 1 },
    );
    await client.callTool({ name: 'get_metrics_summary', arguments: {} });
    const second = await client.callTool({ name: 'get_metrics_summary', arguments: {} });
    expect(second.isError).toBeFalsy();
    expect(spineApi.logins()).toBe(2);
    expect(spineApi.calls.at(-1)?.authorization).toBe('Bearer token-2');
  });

  it('rejects a response that does not match the documented contract', async () => {
    const { client } = await connect({
      [`GET /api/v1/runs/${RUN_ID}`]: () => ({
        status: 200,
        body: { id: RUN_ID, status: 'weird' },
      }),
    });
    const result = await client.callTool({ name: 'get_run', arguments: { runId: RUN_ID } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/unexpected response shape/);
  });

  it('reports a failed login clearly', async () => {
    const spine = new SpineClient({
      baseUrl: 'http://spine.test',
      email: 'ai-analyst@spine.test',
      password: 'wrong',
      timeoutMs: 1_000,
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ title: 'Unauthorized', detail: 'invalid credentials' }), {
            status: 401,
          }),
        )) as typeof fetch,
    });
    await expect(spine.get('/api/v1/alerts', alertSummarySchemaLike)).rejects.toThrow(
      /login failed .*401.*invalid credentials/,
    );
  });
});

describe('triage prompt', () => {
  it('guides the agent and restates the limits', async () => {
    const { client } = await connect({});
    const prompt = await client.getPrompt({
      name: 'triage_alert',
      arguments: { alertId: ALERT_ID },
    });
    const message = prompt.messages[0]!.content as { type: string; text: string };
    expect(message.text).toContain(ALERT_ID);
    expect(message.text).toMatch(/untrusted/);
    expect(message.text).toMatch(/cannot approve runs or close alerts/);
  });
});

describe('configuration', () => {
  it('defaults to dry runs only and lists every problem', () => {
    expect(
      loadMcpConfig({ SPINE_MCP_EMAIL: 'ai-analyst@spine.test', SPINE_MCP_PASSWORD: 'pw' }),
    ).toEqual({
      apiUrl: 'http://localhost:8080',
      email: 'ai-analyst@spine.test',
      password: 'pw',
      allowLiveRuns: false,
      timeoutMs: 10_000,
    });
    expect(() => loadMcpConfig({ SPINE_API_URL: 'not a url' })).toThrow(
      /SPINE_API_URL[\s\S]*SPINE_MCP_EMAIL[\s\S]*SPINE_MCP_PASSWORD/,
    );
  });
});

// A permissive schema for the login-failure test: the request never gets that far.
const alertSummarySchemaLike = { safeParse: () => ({ success: true, data: null }) } as never;
