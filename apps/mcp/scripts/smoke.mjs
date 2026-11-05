#!/usr/bin/env node
// End-to-end smoke test of the Spine MCP server against a RUNNING stack (`make demo` first).
// It spawns the built server (dist/main.js) over stdio, exactly as Claude Code or Claude Desktop
// would, drives the tools like an agent, and then checks each guardrail from the outside.
//
//   pnpm --filter @spine/mcp build && node apps/mcp/scripts/smoke.mjs
//
// Env: SPINE_API_URL (default http://localhost:8080); the AI analyst, analyst and admin demo
// accounts default to the seeded ones (BOOTSTRAP_ADMIN_* from the environment for the admin).
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const api = process.env.SPINE_API_URL ?? 'http://localhost:8080';
const ai = {
  email: process.env.SPINE_MCP_EMAIL ?? 'ai-analyst@spine.test',
  password: process.env.SPINE_MCP_PASSWORD ?? 'night-owl-demo-claude-2026',
};
const human = {
  email: 'analyst@spine.test',
  password: process.env.SPINE_DEMO_ANALYST_PASSWORD ?? 'night-owl-demo-dana-2026',
};
const server = new URL('../dist/main.js', import.meta.url).pathname;
let failures = 0;

function check(label, condition, detail = '') {
  console.log(`${condition ? '  ✔' : '  ✖'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures += 1;
}

async function connect(allowLiveRuns) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: {
      PATH: process.env.PATH ?? '',
      SPINE_API_URL: api,
      SPINE_MCP_EMAIL: ai.email,
      SPINE_MCP_PASSWORD: ai.password,
      SPINE_MCP_ALLOW_LIVE_RUNS: String(allowLiveRuns),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'spine-smoke', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  return { isError: Boolean(result.isError), text, json: result.isError ? null : JSON.parse(text) };
};

async function login({ email, password }) {
  const res = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status}`);
  return (await res.json()).accessToken;
}

async function pendingApprovalFor(runId, token) {
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`${api}/api/v1/approvals?status=pending&limit=200`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const found = (await res.json()).items.find((a) => a.runId === runId);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

console.log(`Spine MCP smoke test against ${api}\n`);
console.log('1. An agent session (live runs disabled, the default)');
const agent = await connect(false);
const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
check('8 tools, none of them can approve, reject or close', tools.length === 8, tools.join(', '));

const queue = await call(agent, 'list_alerts', { text: 'Cobalt Strike', sort: 'score', limit: 5 });
check('list_alerts found the demo malware alert', queue.json?.alerts?.length > 0);
const alertId = queue.json.alerts[0].id;

const detail = await call(agent, 'get_alert', { alertId });
check(
  'get_alert returns the explainable score',
  detail.json?.score?.factors?.length > 1,
  `score ${detail.json?.score?.score}, ${detail.json?.score?.factors?.length} factors`,
);
check('sensor text is fenced under sensorData', typeof detail.json?.sensorData?.title === 'string');
check('the raw payload is not forwarded', !detail.text.includes('"raw"'));

const dry = await call(agent, 'propose_playbook_run', {
  playbookId: 'malware-containment',
  alertId,
});
check('a proposed run is a dry run by default', dry.json?.dryRun === true, dry.json?.runId);
let run;
for (let i = 0; i < 40; i += 1) {
  run = await call(agent, 'get_run', { runId: dry.json.runId });
  if (['succeeded', 'failed', 'compensated', 'cancelled'].includes(run.json?.status)) break;
  await new Promise((r) => setTimeout(r, 250));
}
check(
  'the dry run completed without waiting for a human',
  run.json?.status === 'succeeded',
  run.json?.steps?.map((s) => `${s.step}:${s.status}`).join(' '),
);

const live = await call(agent, 'propose_playbook_run', {
  playbookId: 'malware-containment',
  alertId,
  dryRun: false,
});
check(
  'a live run is refused when not enabled',
  live.isError && /Live runs are disabled/.test(live.text),
);

const close = await agent
  .callTool({ name: 'set_alert_status', arguments: { alertId, status: 'resolved' } })
  .then(
    (r) => r.isError,
    () => true,
  );
check('closing an alert is refused', close === true);
await agent.close();

console.log('\n2. Live runs enabled by the operator: the four-eyes rule still holds');
const liveAgent = await connect(true);
const started = await call(liveAgent, 'propose_playbook_run', {
  playbookId: 'malware-containment',
  alertId,
  dryRun: false,
});
check('the agent can start a live run', started.json?.dryRun === false, started.json?.runId);
await liveAgent.close();

const aiToken = await login(ai);
const approval = await pendingApprovalFor(started.json.runId, aiToken);
check('the run waits for a human approval', approval !== null, approval?.id);
// Simulate a leaked agent token: bypass MCP and call the decision endpoint directly.
const selfApprove = await fetch(`${api}/api/v1/approvals/${approval.id}/decision`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${aiToken}` },
  body: JSON.stringify({ decision: 'approve' }),
});
const problem = await selfApprove.json();
check(
  'even with its raw token, the agent cannot approve its own run',
  selfApprove.status === 403,
  `${selfApprove.status}: ${problem.detail}`,
);
const humanToken = await login(human);
const humanApprove = await fetch(`${api}/api/v1/approvals/${approval.id}/decision`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${humanToken}` },
  body: JSON.stringify({ decision: 'reject', comment: 'smoke test: rejected by a human' }),
});
check('a human analyst can decide it', humanApprove.status === 200, `${humanApprove.status}`);

console.log('\n3. Accountability');
const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
if (adminEmail) {
  const adminToken = await login({
    email: adminEmail,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  const me = await fetch(`${api}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${aiToken}` },
  });
  const aiUser = me.ok ? await me.json() : null;
  const audit = await fetch(
    `${api}/api/v1/audit-log?limit=200${aiUser ? `&actorId=${aiUser.id}` : ''}`,
    {
      headers: { authorization: `Bearer ${adminToken}` },
    },
  );
  const entries = audit.ok ? (await audit.json()).items : [];
  const fromMcp = entries.filter((e) => /spine-mcp/.test(e.userAgent ?? ''));
  check(
    "the audit log attributes the agent's actions to its own account and client",
    fromMcp.length > 0,
    `${fromMcp.length} entries, e.g. ${[...new Set(fromMcp.map((e) => e.action))].slice(0, 4).join(', ')}`,
  );
} else {
  console.log('  - skipped (set BOOTSTRAP_ADMIN_EMAIL/PASSWORD to read the audit log)');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
