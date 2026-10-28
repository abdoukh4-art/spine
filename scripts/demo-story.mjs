#!/usr/bin/env node
// Spine demo story: "Operation Night Owl".
//
// Plays a realistic alert-to-response story against a running Spine stack using only the
// public HTTP API (the same contract any integration would use):
//   1. a phishing email lands in finance                 (canonical alert via signed EDR webhook)
//   2. the user's workstation dumps credentials           (canonical alert, critical asset)
//   3. the IDS sees C2 beaconing, five times              (Suricata EVE via signed webhook → dedup)
//   4. the VPN sees a brute-force attempt                 (CEF batch import)
//   5. a known internal scanner makes noise               (canonical, low score)
// then it waits for enrichment → scoring → playbooks, approves the pending containment
// approval as the analyst, and prints the outcome (scores with explanations, runs, simulated actions).
//
// Everything is synthetic: documentation IP ranges (RFC 5737), example/.test domains, and
// SIMULATED response adapters. Nothing leaves your machine.
//
// Usage: node scripts/demo-story.mjs [--base-url http://localhost:8080] [--no-approve]
// Env:   SPINE_DEMO_ANALYST_EMAIL / SPINE_DEMO_ANALYST_PASSWORD, WEBHOOK_SOURCES_JSON (from .env)

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const BASE =
  (args.includes('--base-url') ? args[args.indexOf('--base-url') + 1] : undefined) ??
  process.env.SPINE_BASE_URL ??
  'http://localhost:8080';
const APPROVE = !args.includes('--no-approve');

loadDotEnv('.env');
const ANALYST_EMAIL = process.env.SPINE_DEMO_ANALYST_EMAIL ?? 'analyst@spine.test';
const ANALYST_PASSWORD = process.env.SPINE_DEMO_ANALYST_PASSWORD ?? 'night-owl-demo-dana-2026';
const sources = JSON.parse(process.env.WEBHOOK_SOURCES_JSON ?? '{}');

const c = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};
const say = (msg) => process.stdout.write(`${msg}\n`);
const step = (n, msg) => say(`\n${c.bold}${c.cyan}[${n}]${c.reset} ${c.bold}${msg}${c.reset}`);

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function http(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const err = new Error(
      `${method} ${path} → ${res.status}: ${typeof json === 'object' ? (json.detail ?? json.title) : text}`,
    );
    err.status = res.status;
    throw err;
  }
  return json;
}

async function webhook(sourceId, payload) {
  const source = sources[sourceId];
  if (!source) throw new Error(`webhook source "${sourceId}" missing from WEBHOOK_SOURCES_JSON`);
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', source.secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return http('POST', `/api/v1/ingest/webhooks/${sourceId}`, {
    raw: body,
    headers: {
      'content-type': 'application/json',
      'x-spine-timestamp': timestamp,
      'x-spine-signature': `sha256=${signature}`,
    },
  });
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

async function main() {
  say(`${c.bold}Spine demo — "Operation Night Owl"${c.reset}  ${c.dim}(${BASE})${c.reset}`);
  await waitFor(
    'API readiness',
    async () => {
      try {
        return (await http('GET', '/readyz')).status === 'ready';
      } catch {
        return false;
      }
    },
    { timeoutMs: 120_000, intervalMs: 2000 },
  );

  step(0, 'Analyst signs in');
  const { accessToken: token, user } = await http('POST', '/api/v1/auth/login', {
    body: { email: ANALYST_EMAIL, password: ANALYST_PASSWORD },
  });
  say(`   signed in as ${user.displayName} (${user.role})`);
  const runTag = randomUUID().slice(0, 8);

  step(
    1,
    'Email gateway → a phishing link reaches a finance user (signed EDR webhook, canonical format)',
  );
  const phishing = await webhook('edr', {
    source: { vendor: 'Acme', product: 'MailGuard', sourceAlertId: `MG-${runTag}-1` },
    title: 'User clicked link in credential-phishing email',
    category: 'phishing',
    severity: 'medium',
    occurredAt: minutesAgo(42),
    user: { name: 'jdoe', email: 'j.doe@corp.example' },
    host: { hostname: 'ws-1042.corp.example', ips: ['192.168.10.42'] },
    url: 'https://login-micros0ft.example/oauth2/authorize',
    indicators: [{ type: 'domain', value: 'login-micros0ft.example' }],
    mitre: [
      {
        tacticId: 'TA0001',
        tacticName: 'Initial Access',
        techniqueId: 'T1566.002',
        techniqueName: 'Spearphishing Link',
      },
    ],
  });
  say(`   alert ${phishing.alertId} (${phishing.status})`);

  step(2, 'EDR → beacon + credential dumping on the finance database server (a critical asset)');
  const creds = await webhook('edr', {
    source: { vendor: 'Acme', product: 'EDR', sourceAlertId: `EDR-${runTag}-7731` },
    title: 'Cobalt Strike beacon and LSASS memory access on fin-db01',
    category: 'malware',
    severity: 'high',
    occurredAt: minutesAgo(30),
    user: { name: 'jdoe' },
    host: { hostname: 'fin-db01.corp.example', ips: ['10.20.5.20'], os: 'Windows Server 2022' },
    file: {
      name: 'svch0st.exe',
      sha256: '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f',
    },
    network: {
      sourceIp: '10.20.5.20',
      destinationIp: '203.0.113.66',
      destinationPort: 443,
      protocol: 'tcp',
    },
    mitre: [
      {
        tacticId: 'TA0006',
        tacticName: 'Credential Access',
        techniqueId: 'T1003.001',
        techniqueName: 'LSASS Memory',
      },
      {
        tacticId: 'TA0002',
        tacticName: 'Execution',
        techniqueId: 'T1059.001',
        techniqueName: 'PowerShell',
      },
    ],
  });
  say(`   alert ${creds.alertId} (${creds.status})`);

  step(3, 'IDS → C2 beaconing to 203.0.113.66, five times (Suricata EVE webhook → deduplication)');
  let beacon;
  for (let i = 0; i < 5; i++) {
    beacon = await webhook('suricata', {
      timestamp: minutesAgo(25 - i * 5),
      flow_id: Number(`7${runTag.replace(/\D/g, '').slice(0, 6) || '1'}`),
      event_type: 'alert',
      src_ip: '10.20.5.20',
      src_port: 50122 + i,
      dest_ip: '203.0.113.66',
      dest_port: 443,
      proto: 'TCP',
      alert: {
        action: 'allowed',
        signature_id: 2027865,
        signature: 'ET MALWARE Observed Cobalt Strike beacon pattern (synthetic demo)',
        category: 'A Network Trojan was detected',
        severity: 1,
        metadata: { mitre_tactic_id: ['TA0011'], mitre_technique_id: ['T1071.001'] },
      },
    });
    say(`   beacon ${i + 1}/5 → alert ${beacon.alertId} (${beacon.status})`);
  }

  step(4, 'VPN concentrator → brute force from 203.0.113.7 (CEF batch import)');
  const cef = [
    `<134>Oct 28 09:12:01 vpn01 CEF:0|Acme|VPN|5.1|4625|Repeated authentication failures|7|src=203.0.113.7 dst=10.0.0.10 dpt=443 suser=admin cnt=57 rt=${Date.now() - 20 * 60_000} cs1Label=tag cs1=${runTag}`,
    `<134>Oct 28 09:13:44 vpn01 CEF:0|Acme|VPN|5.1|4624|Successful login after failures|8|src=203.0.113.7 dst=10.0.0.10 dpt=443 suser=svc-backup rt=${Date.now() - 18 * 60_000} cs1Label=tag cs1=${runTag}`,
  ].join('\n');
  const batch = await http('POST', '/api/v1/ingest/batch?format=cef', {
    token,
    raw: cef,
    headers: { 'content-type': 'text/plain' },
  });
  say(
    `   accepted=${batch.accepted} deduplicated=${batch.deduplicated} rejected=${batch.rejected}`,
  );

  step(5, 'Noise → the internal vulnerability scanner trips a rule (should score low)');
  const noise = await http('POST', '/api/v1/alerts', {
    token,
    headers: { 'idempotency-key': `demo-${runTag}-scanner` },
    body: {
      source: { vendor: 'Acme', product: 'IDS', sourceAlertId: `IDS-${runTag}-scan` },
      title: 'Port scan detected from internal host',
      category: 'reconnaissance',
      severity: 'low',
      occurredAt: minutesAgo(10),
      host: { hostname: 'vuln-scanner01.corp.example', ips: ['10.99.0.5'] },
      network: { sourceIp: '10.99.0.5', destinationIp: '10.20.5.20', protocol: 'tcp' },
      labels: { scanner: 'nessus-internal' },
      mitre: [{ tacticId: 'TA0043', techniqueId: 'T1595' }],
    },
  });
  say(`   alert ${noise.alertId} (${noise.status})`);

  step(6, 'Pipeline: enrichment → scoring (transactional outbox → BullMQ → handlers)');
  const ids = [phishing.alertId, creds.alertId, beacon.alertId, noise.alertId];
  for (const id of ids) {
    const detail = await waitFor(`score for ${id}`, async () => {
      const d = await http('GET', `/api/v1/alerts/${id}`, { token });
      return d.score ? d : null;
    });
    const s = detail.score;
    say(
      `   ${c.bold}${String(s.score).padStart(3)}${c.reset} ${s.severity.padEnd(13)} ${detail.summary.title}`,
    );
    for (const f of s.factors)
      say(
        `        ${c.dim}${f.points >= 0 ? '+' : ''}${f.points}  ${f.description}${f.evidence ? `  [${f.evidence}]` : ''}${c.reset}`,
      );
    if (s.dataGaps?.length) say(`        ${c.yellow}data gaps: ${s.dataGaps.join(', ')}${c.reset}`);
  }

  step(7, 'Playbooks: wait for the containment run to request approval');
  const approval = await waitFor(
    'a pending approval',
    async () => {
      const page = await http('GET', '/api/v1/approvals?status=pending', { token });
      return (
        page.items.find(
          (a) => a.alertId === creds.alertId && a.playbookId === 'malware-containment',
        ) ?? null
      );
    },
    { timeoutMs: 90_000 },
  );
  say(`   "${approval.prompt}"  (playbook ${approval.playbookId}, step ${approval.stepId})`);

  if (APPROVE) {
    step(8, 'Analyst approves the containment');
    await http('POST', `/api/v1/approvals/${approval.id}/decision`, {
      token,
      body: { decision: 'approve', comment: 'Confirmed C2 + credential dumping. Contain.' },
    });
    const run = await waitFor(
      'the run to finish',
      async () => {
        const r = await http('GET', `/api/v1/runs/${approval.runId}`, { token });
        return ['succeeded', 'failed', 'compensated', 'cancelled'].includes(r.status) ? r : null;
      },
      { timeoutMs: 90_000 },
    );
    say(`   run ${run.id}: ${run.status === 'succeeded' ? c.green : c.red}${run.status}${c.reset}`);
    for (const e of run.events)
      say(`        ${c.dim}#${e.seq} ${e.type}${e.stepId ? ` (${e.stepId})` : ''}${c.reset}`);
  } else {
    say(
      `   ${c.yellow}--no-approve: leaving the approval pending — approve it in the console (Approvals page).${c.reset}`,
    );
  }

  step(9, 'What the SIMULATED integrations "did"');
  const actions = await http('GET', '/api/v1/simulated-actions?limit=20', { token });
  for (const a of actions.items.slice(0, 10))
    say(
      `   ${a.kind.padEnd(18)} ${a.dryRun ? '(dry-run) ' : ''}${JSON.stringify(a.response).slice(0, 90)}`,
    );

  step(10, 'SOC metrics (last 7 days)');
  const m = await http('GET', '/api/v1/metrics/summary', { token });
  const fmt = (v) => (v === null ? 'n/a' : `${Math.round(v / 60)} min`);
  say(
    `   alerts: ${m.alertVolume.total}   MTTD mean ${fmt(m.mttd.meanSeconds)} (p50 ${fmt(m.mttd.p50Seconds)})   MTTR mean ${fmt(m.mttr.meanSeconds)} (open ${m.mttr.openCount})`,
  );
  say(
    `   playbook success rate: ${m.playbooks.successRate === null ? 'n/a' : `${Math.round(m.playbooks.successRate * 100)} %`}`,
  );

  say(
    `\n${c.green}${c.bold}Done.${c.reset} Open the console at ${BASE} to explore the queue, the score explanations and the run timeline.`,
  );
}

main().catch((err) => {
  process.stderr.write(`\n${c.red}demo failed:${c.reset} ${err.message}\n`);
  process.exit(1);
});
