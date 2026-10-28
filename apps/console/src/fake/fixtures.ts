import {
  PlaybookDefinitionSchema,
  type Approval,
  type AuditEntry,
  type PlaybookDefinition,
  type PlaybookRecord,
  type RunEventType,
  type SimulatedAction,
  type User,
} from '@spine/shared-schema';
import { buildAlerts, FEATURED_ALERT, type StoredAlert } from './alerts';
import { fakeId, ID_KIND } from './ids';
import { FIXTURE_PLAYBOOKS } from './playbooks';
import { applyEvent, simulatedKindFor, type PlannedEvent, type StoredRun } from './runs';
import { toYaml } from './yaml';

/**
 * Realistic, schema-valid fixture data shared by the tests and the standalone demo
 * (`VITE_USE_FAKE_API=true`). Everything is built relative to `now`, so the demo always
 * looks live, and deterministically, so tests and screenshots are reproducible.
 */

/** Password of every demo account. Fake data only: there is no real account anywhere. */
export const DEMO_PASSWORD = 'spine-demo-password';

/** A user plus the password the fake server checks. */
export interface FakeUser extends User {
  password: string;
}

/** The fake server's whole in-memory state. */
export interface FakeDb {
  users: FakeUser[];
  alerts: StoredAlert[];
  playbooks: PlaybookRecord[];
  runs: StoredRun[];
  approvals: Approval[];
  simulatedActions: SimulatedAction[];
  audit: AuditEntry[];
}

/** Demo accounts, one per role (plus a disabled one). */
export const DEMO_USERS = {
  admin: {
    id: fakeId(ID_KIND.user, 1),
    email: 'ada@spine.local',
    displayName: 'Ada Admin',
    role: 'admin',
  },
  analyst: {
    id: fakeId(ID_KIND.user, 2),
    email: 'sam@spine.local',
    displayName: 'Sam Analyst',
    role: 'analyst',
  },
  viewer: {
    id: fakeId(ID_KIND.user, 3),
    email: 'val@spine.local',
    displayName: 'Val Viewer',
    role: 'viewer',
  },
  disabled: {
    id: fakeId(ID_KIND.user, 4),
    email: 'dan@spine.local',
    displayName: 'Dan Former',
    role: 'analyst',
  },
} as const;

const iso = (ms: number) => new Date(ms).toISOString();

function buildUsers(now: number): FakeUser[] {
  return Object.entries(DEMO_USERS).map(([key, u], i) => ({
    ...u,
    disabled: key === 'disabled',
    createdAt: iso(now - (90 - i) * 86_400_000),
    lastLoginAt: key === 'disabled' ? null : iso(now - (i + 1) * 3_600_000),
    password: DEMO_PASSWORD,
  }));
}

function buildPlaybooks(now: number): PlaybookRecord[] {
  return FIXTURE_PLAYBOOKS.map(({ definition, enabled }, i) => ({
    id: definition.metadata.id,
    version: definition.metadata.version,
    name: definition.metadata.name,
    enabled,
    definition: PlaybookDefinitionSchema.parse(definition),
    source: toYaml(definition),
    createdAt: iso(now - (20 - i * 5) * 86_400_000),
  }));
}

type Script = [RunEventType, string | null, Record<string, unknown>?][];

interface RunSpec {
  n: number;
  playbookId: string;
  alertIndex: number;
  minutesAgo: number;
  trigger: 'auto' | 'manual';
  dryRun?: boolean;
  script: Script;
  /** Events still to come; the fake server emits one per poll. */
  planned?: Script;
}

const toPlanned = ([type, stepId, payload]: Script[number]): PlannedEvent => ({
  type,
  stepId,
  payload: payload ?? {},
});

const C2_TO_APPROVAL: Script = [
  ['run.started', null],
  ['step.started', 'enrich', { attempt: 1 }],
  ['step.succeeded', 'enrich', { output: { lookups: 5, failed: 0 } }],
  ['step.started', 'score', { attempt: 1 }],
  ['step.succeeded', 'score', { output: { score: 100 } }],
  ['step.started', 'severity-gate', { attempt: 1 }],
  ['step.succeeded', 'severity-gate', { taken: 'approve-block' }],
  ['step.started', 'approve-block', { attempt: 1 }],
  ['approval.requested', 'approve-block', {}],
];

const RUN_SPECS: RunSpec[] = [
  {
    n: 1,
    playbookId: 'contain-c2-beacon',
    alertIndex: FEATURED_ALERT.c2,
    minutesAgo: 5,
    trigger: 'auto',
    script: C2_TO_APPROVAL,
  },
  {
    n: 2,
    playbookId: 'contain-c2-beacon',
    alertIndex: FEATURED_ALERT.mimikatz,
    minutesAgo: 14,
    trigger: 'manual',
    script: C2_TO_APPROVAL,
  },
  {
    n: 3,
    playbookId: 'phishing-triage',
    alertIndex: FEATURED_ALERT.phishing,
    minutesAgo: 36,
    trigger: 'auto',
    script: [
      ['run.started', null],
      ['step.started', 'enrich', { attempt: 1 }],
      ['step.succeeded', 'enrich', { output: { lookups: 3, failed: 0 } }],
      ['step.started', 'verdict', { attempt: 1 }],
      ['step.succeeded', 'verdict', { taken: 'ticket' }],
      ['step.started', 'ticket', { attempt: 1 }],
      ['step.succeeded', 'ticket', { output: { ticketId: 'SIM-SOC-4821' } }],
      ['step.started', 'notify', { attempt: 1 }],
      ['step.succeeded', 'notify', { output: { delivered: true } }],
      ['run.succeeded', null],
    ],
  },
  {
    n: 4,
    playbookId: 'phishing-triage',
    alertIndex: FEATURED_ALERT.phishing,
    minutesAgo: 20,
    trigger: 'manual',
    dryRun: true,
    script: [
      ['run.started', null, { dryRun: true }],
      ['step.started', 'enrich', { attempt: 1 }],
      ['step.succeeded', 'enrich', { output: { lookups: 3, failed: 0 } }],
      ['step.started', 'verdict', { attempt: 1 }],
      ['step.succeeded', 'verdict', { taken: 'close-benign' }],
      ['step.started', 'close-benign', { attempt: 1 }],
      ['step.succeeded', 'close-benign', { output: { wouldSetStatus: 'false_positive' } }],
      ['run.succeeded', null],
    ],
  },
  {
    n: 5,
    playbookId: 'contain-c2-beacon',
    alertIndex: FEATURED_ALERT.ransomware,
    minutesAgo: 3 * 24 * 60 - 3,
    trigger: 'manual',
    script: [
      ...C2_TO_APPROVAL,
      ['approval.granted', 'approve-block', { decidedBy: 'Ada Admin' }],
      ['step.started', 'block-ip', { attempt: 1 }],
      ['step.succeeded', 'block-ip', { output: { blocked: ['185.220.101.47'] } }],
      ['step.started', 'open-ticket', { attempt: 1 }],
      [
        'step.failed',
        'open-ticket',
        { attempt: 1, error: 'Ticketing API returned 503 Service Unavailable' },
      ],
      ['step.retry_scheduled', 'open-ticket', { attempt: 2, delayMs: 2000 }],
      ['step.started', 'open-ticket', { attempt: 2 }],
      [
        'step.failed',
        'open-ticket',
        { attempt: 2, error: 'Ticketing API returned 503 Service Unavailable' },
      ],
      ['compensation.started', null, { reason: 'step open-ticket failed' }],
      ['compensation.step_succeeded', 'block-ip', { action: 'unblock_indicator' }],
      ['run.compensated', null],
    ],
  },
  {
    n: 6,
    playbookId: 'brute-force-response',
    alertIndex: FEATURED_ALERT.spraying,
    minutesAgo: 120,
    trigger: 'auto',
    script: [
      ['run.started', null],
      ['step.started', 'enrich', { attempt: 1 }],
      ['step.succeeded', 'enrich', { output: { lookups: 1, failed: 1 } }],
      ['step.started', 'notify-identity', { attempt: 1 }],
      [
        'step.failed',
        'notify-identity',
        { attempt: 1, error: 'Channel #identity-team not found', continued: true },
      ],
      ['step.started', 'ticket', { attempt: 1 }],
      ['step.failed', 'ticket', { attempt: 1, error: 'Queue IAM does not exist' }],
      ['run.failed', null, { error: 'step ticket failed' }],
    ],
  },
  {
    n: 7,
    playbookId: 'contain-c2-beacon',
    alertIndex: FEATURED_ALERT.exploit,
    minutesAgo: 1,
    trigger: 'manual',
    dryRun: true,
    script: [
      ['run.started', null, { dryRun: true }],
      ['step.started', 'enrich', { attempt: 1 }],
    ],
    planned: [
      ['step.succeeded', 'enrich', { output: { lookups: 2, failed: 1 } }],
      ['step.started', 'score', { attempt: 1 }],
      ['step.succeeded', 'score', { output: { score: 85 } }],
      ['step.started', 'severity-gate', { attempt: 1 }],
      ['step.succeeded', 'severity-gate', { taken: 'notify-soc' }],
      ['step.started', 'notify-soc', { attempt: 1 }],
      ['step.succeeded', 'notify-soc', { output: { delivered: true } }],
      ['run.succeeded', null],
    ],
  },
  {
    n: 8,
    playbookId: 'contain-c2-beacon',
    alertIndex: FEATURED_ALERT.nmap,
    minutesAgo: 26 * 60 - 2,
    trigger: 'auto',
    script: [
      ...C2_TO_APPROVAL,
      ['approval.rejected', 'approve-block', { decidedBy: 'Sam Analyst' }],
      ['step.started', 'notify-soc', { attempt: 1 }],
      ['step.succeeded', 'notify-soc', { output: { delivered: true } }],
      ['run.succeeded', null],
    ],
  },
];

function buildRun(
  spec: RunSpec,
  now: number,
  alerts: StoredAlert[],
  playbooks: PlaybookRecord[],
): StoredRun {
  const playbook = playbooks.find((p) => p.id === spec.playbookId);
  const alert = alerts[spec.alertIndex];
  if (!playbook || !alert) throw new Error(`bad run fixture ${String(spec.n)}`);
  const createdMs = now - spec.minutesAgo * 60_000;
  const stored: StoredRun = {
    definition: playbook.definition,
    planned: (spec.planned ?? []).map(toPlanned),
    run: {
      id: fakeId(ID_KIND.run, spec.n),
      playbookId: playbook.id,
      playbookVersion: playbook.version,
      alertId: alert.alert.id,
      status: 'pending',
      dryRun: spec.dryRun ?? false,
      trigger: spec.trigger,
      currentStepId: null,
      createdAt: iso(createdMs),
      startedAt: null,
      finishedAt: null,
      events: [],
      steps: [],
    },
  };
  spec.script.forEach((entry, i) =>
    applyEvent(stored, toPlanned(entry), iso(createdMs + 500 + i * 1_700)),
  );
  return stored;
}

/** Builds the approval record for a run that reached (or passed) its approval gate. */
function approvalFor(
  stored: StoredRun,
  n: number,
  expiresInMinutes: number,
  now: number,
): Approval {
  const requested = stored.run.events.find((e) => e.type === 'approval.requested');
  const decision = stored.run.events.find(
    (e) => e.type === 'approval.granted' || e.type === 'approval.rejected',
  );
  const step = stored.definition.steps.find((s) => s.id === requested?.stepId);
  const prompt = step?.type === 'approval' ? step.with.prompt : 'Approve?';
  const requestedAt = requested?.occurredAt ?? stored.run.createdAt;
  const decidedBy =
    decision?.payload.decidedBy === 'Ada Admin'
      ? DEMO_USERS.admin.id
      : decision
        ? DEMO_USERS.analyst.id
        : null;
  return {
    id: fakeId(ID_KIND.approval, n),
    runId: stored.run.id,
    stepId: requested?.stepId ?? 'approve-block',
    alertId: stored.run.alertId,
    playbookId: stored.run.playbookId,
    status: decision ? (decision.type === 'approval.granted' ? 'approved' : 'rejected') : 'pending',
    approverRole: 'analyst',
    prompt: prompt.replace('{{alert.network.destinationIp}}', '185.220.101.47'),
    requestedAt,
    expiresAt: iso(
      decision ? Date.parse(requestedAt) + 3_600_000 : now + expiresInMinutes * 60_000,
    ),
    decidedAt: decision?.occurredAt ?? null,
    decidedBy,
    comment:
      decision?.type === 'approval.granted'
        ? 'Confirmed ransomware staging host. Contain.'
        : decision
          ? 'Approved internal scanner, not a C2 host.'
          : null,
  };
}

/** Request/response bodies the simulated adapters record for one action kind. */
export function simulatedBodies(
  kind: SimulatedAction['kind'],
  stepWith: Record<string, unknown>,
  seq: number,
): Pick<SimulatedAction, 'request' | 'response'> {
  switch (kind) {
    case 'firewall.block':
      return {
        request: {
          indicator: '185.220.101.47',
          type: 'ipv4',
          durationMinutes: stepWith.durationMinutes ?? 1440,
        },
        response: { ruleId: `sim-fw-${String(1040 + seq)}`, status: 'blocked' },
      };
    case 'firewall.unblock':
      return {
        request: { ruleId: `sim-fw-${String(1040 + seq - 1)}` },
        response: { status: 'removed' },
      };
    case 'ticket.create':
      return {
        request: { queue: stepWith.queue ?? 'SOC', priority: stepWith.priority ?? 'medium' },
        response: {
          ticketId: `SIM-SOC-${String(4820 + seq)}`,
          url: `https://tickets.simulated.invalid/SIM-SOC-${String(4820 + seq)}`,
        },
      };
    case 'ticket.close':
      return {
        request: { ticketId: `SIM-SOC-${String(4820 + seq)}` },
        response: { status: 'closed' },
      };
    case 'chat.post':
      return {
        request: { channel: stepWith.channel ?? '#soc', text: stepWith.template ?? '' },
        response: { messageId: `sim-msg-${String(seq)}`, delivered: true },
      };
    case 'alert.set_status':
      return { request: { status: stepWith.status ?? 'in_progress' }, response: { ok: true } };
  }
}

/** Derives the simulated actions a run's succeeded (and compensated) steps performed. */
export function actionsForRun(stored: StoredRun, startSeq: number): SimulatedAction[] {
  const actions: SimulatedAction[] = [];
  for (const event of stored.run.events) {
    const step = stored.definition.steps.find((s) => s.id === event.stepId);
    if (!step) continue;
    let kind: SimulatedAction['kind'] | null = null;
    if (event.type === 'step.succeeded') kind = simulatedKindFor(step.type);
    if (event.type === 'compensation.step_succeeded') {
      kind = step.type === 'block_indicator' ? 'firewall.unblock' : 'ticket.close';
    }
    if (!kind) continue;
    const seq = startSeq + actions.length;
    const stepWith = 'with' in step ? (step.with as Record<string, unknown>) : {};
    actions.push({
      id: fakeId(ID_KIND.action, seq),
      kind,
      runId: stored.run.id,
      stepId: step.id,
      dryRun: stored.run.dryRun,
      ...simulatedBodies(kind, stepWith, seq),
      createdAt: event.occurredAt,
    });
  }
  return actions;
}

function buildAudit(now: number): AuditEntry[] {
  const entries: [number, string, string | null, string | null, string | null, number][] = [
    [2, 'auth.login.succeeded', DEMO_USERS.analyst.id, 'user', DEMO_USERS.analyst.id, 200],
    [3, 'auth.login.failed', null, 'user', null, 401],
    [40, 'PATCH /api/v1/alerts/:id', DEMO_USERS.analyst.id, 'alert', fakeId(ID_KIND.alert, 2), 200],
    [60, 'auth.login.succeeded', DEMO_USERS.admin.id, 'user', DEMO_USERS.admin.id, 200],
    [
      61,
      'PATCH /api/v1/playbooks/:id',
      DEMO_USERS.admin.id,
      'playbook',
      'brute-force-response',
      200,
    ],
    [
      26 * 60,
      'approval.decided',
      DEMO_USERS.analyst.id,
      'approval',
      fakeId(ID_KIND.approval, 4),
      200,
    ],
    [
      3 * 24 * 60,
      'approval.decided',
      DEMO_USERS.admin.id,
      'approval',
      fakeId(ID_KIND.approval, 3),
      200,
    ],
    [7 * 24 * 60, 'POST /api/v1/users', DEMO_USERS.admin.id, 'user', DEMO_USERS.viewer.id, 201],
  ];
  return entries.map(([minutesAgo, action, actorId, targetType, targetId, status], i) => ({
    id: fakeId(ID_KIND.audit, i + 1),
    occurredAt: iso(now - minutesAgo * 60_000),
    actorId,
    actorType: actorId ? 'user' : 'anonymous',
    action,
    targetType,
    targetId,
    outcomeStatus: status,
    requestId: `req-${(9000 + i).toString(36)}`,
    ip: actorId ? '10.1.2.3' : '198.51.100.77',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    details: action === 'auth.login.failed' ? { email: 'unknown@spine.local' } : {},
  }));
}

/** Builds a complete, consistent fake database relative to `now` (epoch ms). */
export function createFakeDb(now: number): FakeDb {
  const users = buildUsers(now);
  const alerts = buildAlerts(now, { ada: DEMO_USERS.admin.id, sam: DEMO_USERS.analyst.id });
  const playbooks = buildPlaybooks(now);
  const runs = RUN_SPECS.map((spec) => buildRun(spec, now, alerts, playbooks));
  const byN = (n: number) => runs[n - 1] as StoredRun;
  const approvals = [
    approvalFor(byN(1), 1, 42, now),
    approvalFor(byN(2), 2, 3, now),
    approvalFor(byN(5), 3, 0, now),
    approvalFor(byN(8), 4, 0, now),
  ];
  const simulatedActions: SimulatedAction[] = [];
  for (const run of runs) simulatedActions.push(...actionsForRun(run, simulatedActions.length + 1));
  return { users, alerts, playbooks, runs, approvals, simulatedActions, audit: buildAudit(now) };
}

/** Typed access to the definition of a fixture playbook (handy in tests). */
export function fixtureDefinition(db: FakeDb, id: string): PlaybookDefinition {
  const record = db.playbooks.find((p) => p.id === id);
  if (!record) throw new Error(`no fixture playbook ${id}`);
  return record.definition;
}
