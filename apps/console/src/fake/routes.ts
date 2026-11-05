import {
  ALERT_STATUSES,
  ApprovalDecisionSchema,
  CreateUserRequestSchema,
  LoginRequestSchema,
  PlaybookDefinitionSchema,
  PlaybookSourceRequestSchema,
  SEVERITIES,
  StartRunRequestSchema,
  TERMINAL_RUN_STATUSES,
  UpdateAlertRequestSchema,
  UpdateUserRequestSchema,
  isAllowedAlertTransition,
  roleSatisfies,
  type AlertDetail,
  type AlertStatus,
  type AlertSummary,
  type Approval,
  type PlaybookSummary,
  type Role,
} from '@spine/shared-schema';
import type { z } from 'zod';
import type { StoredAlert } from './alerts';
import { actionsForRun } from './fixtures';
import { FakeProblem, empty, json, paginate, publicUser } from './http';
import { fakeId, ID_KIND } from './ids';
import { computeMetrics } from './metrics';
import { applyEvent, planFrom, type StoredRun } from './runs';
import type { RouteContext } from './server';

/** One fake endpoint: method, path pattern (`:param` segments), required access, handler. */
export interface FakeRoute {
  method: 'GET' | 'POST' | 'PATCH';
  pattern: string;
  access: Role | 'public';
  handler: (ctx: RouteContext) => Response | Promise<Response>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Parses a request body with a shared schema, answering 400 `validation-error` like the API. */
function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new FakeProblem(
      400,
      'validation-error',
      'Validation failed',
      'The request body does not match the schema.',
      parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    );
  }
  return parsed.data as z.infer<S>;
}

function requireCsrf(ctx: RouteContext): void {
  if (ctx.headers.get('X-Spine-CSRF') !== '1') {
    throw new FakeProblem(403, 'forbidden', 'Missing CSRF header');
  }
}

function findAlert(ctx: RouteContext): StoredAlert {
  const found = ctx.server.db.alerts.find((a) => a.alert.id === ctx.params.id);
  if (!found) throw new FakeProblem(404, 'not-found', 'Alert not found');
  return found;
}

function findRun(ctx: RouteContext, id = ctx.params.id): StoredRun {
  const found = ctx.server.db.runs.find((r) => r.run.id === id);
  if (!found) throw new FakeProblem(404, 'not-found', 'Run not found');
  return found;
}

/** Projects a stored alert onto the `AlertSummary` DTO. */
export function toSummary(stored: StoredAlert): AlertSummary {
  const { alert } = stored;
  return {
    id: alert.id,
    title: alert.title,
    category: alert.category,
    status: alert.status,
    sourceSeverity: alert.severity,
    severity: stored.severity,
    score: stored.score?.score ?? null,
    source: { vendor: alert.source.vendor, product: alert.source.product },
    occurredAt: alert.occurredAt,
    receivedAt: alert.receivedAt,
    lastSeenAt: alert.lastSeenAt,
    duplicateCount: alert.duplicateCount,
    assigneeId: stored.assigneeId,
    caseId: stored.caseId,
    mitre: alert.mitre,
    resolvedAt: stored.resolvedAt,
  };
}

function alertMatches(stored: StoredAlert, q: URLSearchParams): boolean {
  const statuses = q.getAll('status');
  const severities = q.getAll('severity');
  const minScore = q.get('minScore');
  const text = q.get('q')?.toLowerCase();
  const technique = q.get('technique')?.toUpperCase();
  const { alert } = stored;
  if (statuses.length > 0 && !statuses.includes(alert.status)) return false;
  if (severities.length > 0 && !severities.includes(stored.severity ?? alert.severity))
    return false;
  if (minScore && (stored.score === null || stored.score.score < Number(minScore))) return false;
  if (q.get('category') && alert.category !== q.get('category')) return false;
  if (q.get('assigneeId') && stored.assigneeId !== q.get('assigneeId')) return false;
  if (technique && !alert.mitre.some((m) => m.techniqueId.startsWith(technique))) return false;
  // ADR-0037: `q` is a case-insensitive substring of the title only.
  if (text && !alert.title.toLowerCase().includes(text)) return false;
  return true;
}

function listAlerts(ctx: RouteContext): Response {
  const q = ctx.query;
  const invalid = [
    ...q.getAll('status').filter((s) => !(ALERT_STATUSES as readonly string[]).includes(s)),
    ...q.getAll('severity').filter((s) => !(SEVERITIES as readonly string[]).includes(s)),
  ];
  if (invalid.length > 0) {
    throw new FakeProblem(
      400,
      'validation-error',
      'Validation failed',
      `Unknown filter value: ${invalid.join(', ')}`,
    );
  }
  const sort = q.get('sort') === 'score' ? 'score' : 'receivedAt';
  const direction = q.get('order') === 'asc' ? 1 : -1;
  const items = ctx.server.db.alerts.filter((a) => alertMatches(a, q)).map(toSummary);
  items.sort((a, b) => {
    if (sort === 'score') {
      if (a.score === null || b.score === null)
        return a.score === b.score ? 0 : a.score === null ? 1 : -1;
      if (a.score !== b.score) return (a.score - b.score) * direction;
    }
    return a.receivedAt.localeCompare(b.receivedAt) * direction;
  });
  return json(200, paginate(items, q));
}

function alertDetail(ctx: RouteContext): Response {
  const stored = findAlert(ctx);
  const detail: AlertDetail = {
    summary: toSummary(stored),
    alert: stored.alert,
    enrichments: stored.enrichments,
    score: stored.score,
    runs: ctx.server.db.runs
      .filter((r) => r.run.alertId === stored.alert.id)
      .map(({ run }) => {
        const { events: _e, steps: _s, ...summary } = run;
        return summary;
      }),
  };
  return json(200, detail);
}

function updateAlert(ctx: RouteContext): Response {
  const stored = findAlert(ctx);
  const body = parseBody(UpdateAlertRequestSchema, ctx.body);
  if (body.status && body.status !== stored.alert.status) {
    if (!isAllowedAlertTransition(stored.alert.status, body.status)) {
      throw new FakeProblem(
        409,
        'conflict',
        'Illegal status transition',
        `Cannot move an alert from ${stored.alert.status} to ${body.status}.`,
      );
    }
    stored.alert.status = body.status;
    const closed: AlertStatus[] = ['resolved', 'false_positive'];
    // ADR-0036: resolvedAt is the *first* close and never moves (not even on reopen).
    if (closed.includes(body.status) && stored.resolvedAt === null)
      stored.resolvedAt = iso(ctx.now);
  }
  if (body.assigneeId !== undefined) {
    if (body.assigneeId !== null && !ctx.server.db.users.some((u) => u.id === body.assigneeId)) {
      throw new FakeProblem(422, 'unprocessable', 'Unknown assignee');
    }
    stored.assigneeId = body.assigneeId;
  }
  if (body.caseId !== undefined) stored.caseId = body.caseId;
  return json(200, toSummary(stored));
}

function reEnrich(ctx: RouteContext): Response {
  const stored = findAlert(ctx);
  // Pretend the providers recovered: failed lookups now return "not found".
  stored.enrichments = stored.enrichments.map((e) =>
    e.status === 'ok' || e.status === 'not_found' || e.status === 'skipped'
      ? { ...e, fetchedAt: iso(ctx.now) }
      : {
          provider: e.provider,
          indicator: e.indicator,
          status: 'not_found',
          durationMs: 120,
          fetchedAt: iso(ctx.now),
        },
  );
  if (stored.score) stored.score = { ...stored.score, dataGaps: [], computedAt: iso(ctx.now) };
  return empty(202);
}

/** Emits one planned event per poll, so the demo's run timeline visibly progresses. */
function tick(ctx: RouteContext, stored: StoredRun): void {
  if (stored.run.status === 'waiting_approval') return;
  const next = stored.planned.shift();
  if (!next) return;
  const at = iso(ctx.now);
  applyEvent(stored, next, at);
  const { db } = ctx.server;
  if (next.type === 'approval.requested') {
    const step = stored.definition.steps.find((s) => s.id === next.stepId);
    const expiresIn = step?.type === 'approval' ? step.with.expiresInMs : 3_600_000;
    db.approvals.unshift({
      id: fakeId(ID_KIND.approval, 100 + db.approvals.length),
      runId: stored.run.id,
      stepId: next.stepId ?? '',
      alertId: stored.run.alertId,
      playbookId: stored.run.playbookId,
      status: 'pending',
      approverRole: step?.type === 'approval' ? step.with.approverRole : 'analyst',
      prompt: step?.type === 'approval' ? step.with.prompt : 'Approve?',
      requestedAt: at,
      expiresAt: iso(ctx.now + expiresIn),
      decidedAt: null,
      decidedBy: null,
      comment: null,
    });
  }
  if (next.type === 'step.succeeded') {
    const created = actionsForRun(
      { ...stored, run: { ...stored.run, events: stored.run.events.slice(-1) } },
      200 + db.simulatedActions.length,
    );
    db.simulatedActions.unshift(...created.map((a) => ({ ...a, createdAt: at })));
  }
}

function startRun(ctx: RouteContext): Response {
  const record = ctx.server.db.playbooks.find((p) => p.id === ctx.params.id);
  if (!record) throw new FakeProblem(404, 'not-found', 'Playbook not found');
  const body = parseBody(StartRunRequestSchema, ctx.body);
  if (!ctx.server.db.alerts.some((a) => a.alert.id === body.alertId)) {
    throw new FakeProblem(404, 'not-found', 'Alert not found');
  }
  const runs = ctx.server.db.runs;
  const stored: StoredRun = {
    definition: record.definition,
    planned: planFrom(record.definition, record.definition.start),
    run: {
      id: fakeId(ID_KIND.run, 1000 + runs.length),
      playbookId: record.id,
      playbookVersion: record.version,
      alertId: body.alertId,
      status: 'pending',
      dryRun: body.dryRun,
      trigger: 'manual',
      currentStepId: null,
      createdAt: iso(ctx.now),
      startedAt: null,
      finishedAt: null,
      events: [],
      steps: [],
    },
  };
  applyEvent(
    stored,
    { type: 'run.started', stepId: null, payload: { dryRun: body.dryRun } },
    iso(ctx.now),
  );
  runs.unshift(stored);
  return json(202, { runId: stored.run.id });
}

function decideApproval(ctx: RouteContext): Response {
  const user = ctx.user;
  const approval = ctx.server.db.approvals.find((a) => a.id === ctx.params.id);
  if (!approval || !user) throw new FakeProblem(404, 'not-found', 'Approval not found');
  const body = parseBody(ApprovalDecisionSchema, ctx.body);
  if (!roleSatisfies(user.role, approval.approverRole)) {
    throw new FakeProblem(
      403,
      'forbidden',
      'Forbidden',
      `Needs the ${approval.approverRole} role.`,
    );
  }
  if (approval.status === 'pending' && Date.parse(approval.expiresAt) < ctx.now)
    approval.status = 'expired';
  if (approval.status !== 'pending') {
    throw new FakeProblem(
      409,
      'conflict',
      'Approval already decided',
      `This approval is already ${approval.status}.`,
    );
  }
  approval.status = body.decision === 'approve' ? 'approved' : 'rejected';
  approval.decidedAt = iso(ctx.now);
  approval.decidedBy = user.id;
  approval.comment = body.comment ?? null;
  const stored = ctx.server.db.runs.find((r) => r.run.id === approval.runId);
  if (stored) {
    const type = body.decision === 'approve' ? 'approval.granted' : 'approval.rejected';
    applyEvent(
      stored,
      {
        type,
        stepId: approval.stepId,
        payload: {
          approvalId: approval.id,
          decidedBy: user.id,
          comment: approval.comment,
          reason: 'decision',
        },
      },
      iso(ctx.now),
    );
    const step = stored.definition.steps.find((s) => s.id === approval.stepId);
    const next =
      step?.type === 'approval'
        ? body.decision === 'approve'
          ? step.next
          : step.onReject
        : undefined;
    stored.planned = planFrom(stored.definition, next);
  }
  return json(200, approval);
}

function cancelRun(ctx: RouteContext): Response {
  const stored = findRun(ctx);
  if (TERMINAL_RUN_STATUSES.includes(stored.run.status)) {
    throw new FakeProblem(409, 'conflict', 'Run already finished');
  }
  stored.planned = [];
  applyEvent(
    stored,
    {
      type: 'run.cancelled',
      stepId: null,
      payload: { cancelledBy: ctx.user?.id ?? null, previousStatus: stored.run.status },
    },
    iso(ctx.now),
  );
  return empty(202);
}

function playbookSummaries(ctx: RouteContext): PlaybookSummary[] {
  return ctx.server.db.playbooks.map((p) => ({
    id: p.id,
    latestVersion: p.version,
    name: p.name,
    description: p.definition.metadata.description ?? null,
    enabled: p.enabled,
    stepCount: p.definition.steps.length,
    tags: p.definition.metadata.tags,
  }));
}

/**
 * The fake can't parse YAML (that would need a YAML library in the bundle), so YAML input
 * gets a structural check only; JSON input is validated with the real schema.
 */
function validatePlaybook(ctx: RouteContext): Response {
  const { source, format } = parseBody(PlaybookSourceRequestSchema, ctx.body);
  const invalid = (errors: { path: string; message: string }[]) =>
    new FakeProblem(
      422,
      'playbook-invalid',
      'Playbook is invalid',
      `${String(errors.length)} problem(s) found.`,
      errors,
    );
  if (format === 'json') {
    let data: unknown;
    try {
      data = JSON.parse(source);
    } catch (error) {
      throw invalid([
        { path: '(root)', message: error instanceof Error ? error.message : 'Invalid JSON' },
      ]);
    }
    const parsed = PlaybookDefinitionSchema.safeParse(data);
    if (!parsed.success)
      throw invalid(
        parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      );
    return json(200, { valid: true, definition: parsed.data });
  }
  const errors: { path: string; message: string }[] = [];
  for (const key of ['apiVersion', 'kind', 'metadata', 'start', 'steps']) {
    if (!new RegExp(`^${key}:`, 'm').test(source)) errors.push({ path: key, message: 'Required' });
  }
  if (/^apiVersion:/m.test(source) && !/^apiVersion:\s*spine\/v1\s*$/m.test(source)) {
    errors.push({ path: 'apiVersion', message: 'Invalid input: expected "spine/v1"' });
  }
  const start = /^start:\s*(\S+)/m.exec(source)?.[1];
  if (start && !new RegExp(`-\\s+id:\\s*${start}\\s*$`, 'm').test(source)) {
    errors.push({ path: 'start', message: `start step "${start}" is not defined in steps` });
  }
  if (errors.length > 0) throw invalid(errors);
  const id = /^\s+id:\s*(\S+)/m.exec(source)?.[1];
  const known = ctx.server.db.playbooks.find((p) => p.id === id) ?? ctx.server.db.playbooks[0];
  if (!known) throw invalid([{ path: 'metadata.id', message: 'Unknown playbook' }]);
  return json(200, { valid: true, definition: known.definition });
}

function filterByTime<T extends { occurredAt: string }>(
  items: T[],
  from: string | null,
  to: string | null,
): T[] {
  return items.filter((i) => (!from || i.occurredAt >= from) && (!to || i.occurredAt <= to));
}

const WINDOW_DEFAULT_MS = 7 * 86_400_000;

/** Every endpoint of the contract the console uses, implemented over the fake database. */
export const ROUTES: FakeRoute[] = [
  {
    method: 'POST',
    pattern: '/auth/login',
    access: 'public',
    handler: (ctx) => {
      const body = parseBody(LoginRequestSchema, ctx.body);
      const user = ctx.server.findUserByEmail(body.email);
      if (!user || user.disabled || user.password !== body.password) {
        throw new FakeProblem(401, 'unauthenticated', 'Invalid email or password');
      }
      user.lastLoginAt = iso(ctx.now);
      return json(200, ctx.server.issueTokens(user));
    },
  },
  {
    method: 'POST',
    pattern: '/auth/refresh',
    access: 'public',
    handler: (ctx) => {
      requireCsrf(ctx);
      const userId = ctx.server.cookieJar.get();
      const user = ctx.server.db.users.find((u) => u.id === userId && !u.disabled);
      if (!user) {
        ctx.server.cookieJar.clear();
        throw new FakeProblem(401, 'unauthenticated', 'Session expired');
      }
      return json(200, ctx.server.issueTokens(user));
    },
  },
  {
    method: 'POST',
    pattern: '/auth/logout',
    access: 'public',
    handler: (ctx) => {
      requireCsrf(ctx);
      ctx.server.cookieJar.clear();
      return empty(204);
    },
  },
  {
    method: 'GET',
    pattern: '/auth/me',
    access: 'viewer',
    handler: (ctx) => json(200, ctx.user && publicUser(ctx.user)),
  },
  { method: 'GET', pattern: '/alerts', access: 'viewer', handler: listAlerts },
  { method: 'GET', pattern: '/alerts/:id', access: 'viewer', handler: alertDetail },
  { method: 'PATCH', pattern: '/alerts/:id', access: 'analyst', handler: updateAlert },
  { method: 'POST', pattern: '/alerts/:id/enrich', access: 'analyst', handler: reEnrich },
  {
    method: 'GET',
    pattern: '/cases',
    access: 'viewer',
    handler: () => json(200, { items: [], nextCursor: null }),
  },
  {
    method: 'GET',
    pattern: '/enrichment/providers',
    access: 'viewer',
    handler: () =>
      json(200, [
        {
          name: 'abuse-db',
          supports: ['ipv4', 'domain', 'url', 'sha256'],
          circuit: 'closed',
          inFlight: 0,
          queued: 0,
        },
        { name: 'geo-ip', supports: ['ipv4', 'ipv6'], circuit: 'open', inFlight: 0, queued: 0 },
        { name: 'cmdb', supports: ['hostname'], circuit: 'closed', inFlight: 0, queued: 0 },
      ]),
  },
  {
    method: 'GET',
    pattern: '/scoring/ruleset',
    access: 'viewer',
    handler: () =>
      json(200, {
        version: 4,
        baseline: {
          fromSeverity: { informational: 5, low: 15, medium: 30, high: 50, critical: 70 },
        },
        rules: [
          {
            id: 'malicious-reputation',
            description: 'An indicator has a malicious reputation verdict',
            when: { field: 'enrichment.verdicts', op: 'contains', value: 'malicious' },
            points: 25,
          },
        ],
      }),
  },
  {
    method: 'GET',
    pattern: '/playbooks',
    access: 'viewer',
    handler: (ctx) => json(200, playbookSummaries(ctx)),
  },
  { method: 'POST', pattern: '/playbooks/validate', access: 'analyst', handler: validatePlaybook },
  {
    method: 'GET',
    pattern: '/playbooks/:id',
    access: 'viewer',
    handler: (ctx) => {
      const record = ctx.server.db.playbooks.find((p) => p.id === ctx.params.id);
      if (!record) throw new FakeProblem(404, 'not-found', 'Playbook not found');
      return json(200, record);
    },
  },
  {
    method: 'PATCH',
    pattern: '/playbooks/:id',
    access: 'admin',
    handler: (ctx) => {
      const record = ctx.server.db.playbooks.find((p) => p.id === ctx.params.id);
      if (!record) throw new FakeProblem(404, 'not-found', 'Playbook not found');
      const body = ctx.body as { enabled?: unknown } | undefined;
      if (typeof body?.enabled !== 'boolean')
        throw new FakeProblem(400, 'validation-error', 'enabled must be a boolean');
      record.enabled = body.enabled;
      return json(
        200,
        playbookSummaries(ctx).find((p) => p.id === record.id),
      );
    },
  },
  { method: 'POST', pattern: '/playbooks/:id/runs', access: 'analyst', handler: startRun },
  {
    method: 'GET',
    pattern: '/runs',
    access: 'viewer',
    handler: (ctx) => {
      const q = ctx.query;
      const items = ctx.server.db.runs
        .map(({ run }) => {
          const { events: _e, steps: _s, ...summary } = run;
          return summary;
        })
        .filter(
          (r) =>
            (!q.get('playbookId') || r.playbookId === q.get('playbookId')) &&
            (!q.get('alertId') || r.alertId === q.get('alertId')) &&
            (!q.get('status') || r.status === q.get('status')),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(200, paginate(items, q));
    },
  },
  {
    method: 'GET',
    pattern: '/runs/:id',
    access: 'viewer',
    handler: (ctx) => {
      const stored = findRun(ctx);
      tick(ctx, stored);
      return json(200, stored.run);
    },
  },
  { method: 'POST', pattern: '/runs/:id/cancel', access: 'analyst', handler: cancelRun },
  {
    method: 'GET',
    pattern: '/approvals',
    access: 'viewer',
    handler: (ctx) => {
      const status = ctx.query.get('status');
      for (const a of ctx.server.db.approvals) {
        if (a.status === 'pending' && Date.parse(a.expiresAt) < ctx.now) a.status = 'expired';
      }
      const items: Approval[] = ctx.server.db.approvals
        .filter((a) => !status || a.status === status)
        // Same order as the real API: newest request first.
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      return json(200, paginate(items, ctx.query));
    },
  },
  {
    method: 'POST',
    pattern: '/approvals/:id/decision',
    access: 'analyst',
    handler: decideApproval,
  },
  {
    method: 'GET',
    pattern: '/simulated-actions',
    access: 'viewer',
    handler: (ctx) => {
      const kind = ctx.query.get('kind');
      const items = ctx.server.db.simulatedActions
        .filter((a) => !kind || a.kind === kind)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(200, paginate(items, ctx.query));
    },
  },
  {
    method: 'GET',
    pattern: '/metrics/summary',
    access: 'viewer',
    handler: (ctx) => {
      const to = ctx.query.get('to') ? Date.parse(ctx.query.get('to') ?? '') : ctx.now;
      const from = ctx.query.get('from')
        ? Date.parse(ctx.query.get('from') ?? '')
        : to - WINDOW_DEFAULT_MS;
      return json(200, computeMetrics(ctx.server.db, from, to));
    },
  },
  {
    method: 'GET',
    pattern: '/users',
    access: 'admin',
    handler: (ctx) => json(200, paginate(ctx.server.db.users.map(publicUser), ctx.query)),
  },
  {
    method: 'POST',
    pattern: '/users',
    access: 'admin',
    handler: (ctx) => {
      const body = parseBody(CreateUserRequestSchema, ctx.body);
      if (ctx.server.findUserByEmail(body.email)) {
        throw new FakeProblem(
          409,
          'conflict',
          'Email already in use',
          `A user with ${body.email} already exists.`,
        );
      }
      const user = {
        id: fakeId(ID_KIND.user, 100 + ctx.server.db.users.length),
        email: body.email,
        displayName: body.displayName,
        role: body.role,
        disabled: false,
        createdAt: iso(ctx.now),
        lastLoginAt: null,
        password: body.password,
      };
      ctx.server.db.users.push(user);
      return json(201, publicUser(user));
    },
  },
  {
    method: 'PATCH',
    pattern: '/users/:id',
    access: 'admin',
    handler: (ctx) => {
      const user = ctx.server.db.users.find((u) => u.id === ctx.params.id);
      if (!user) throw new FakeProblem(404, 'not-found', 'User not found');
      const body = parseBody(UpdateUserRequestSchema, ctx.body);
      if (
        user.id === ctx.user?.id &&
        (body.disabled === true || (body.role && body.role !== 'admin'))
      ) {
        throw new FakeProblem(409, 'conflict', 'You cannot demote or disable yourself');
      }
      if (body.displayName !== undefined) user.displayName = body.displayName;
      if (body.role !== undefined) user.role = body.role;
      if (body.disabled !== undefined) user.disabled = body.disabled;
      return json(200, publicUser(user));
    },
  },
  {
    method: 'GET',
    pattern: '/audit-log',
    access: 'admin',
    handler: (ctx) => {
      const q = ctx.query;
      const action = q.get('action')?.toLowerCase();
      const items = filterByTime(ctx.server.db.audit, q.get('from'), q.get('to'))
        .filter(
          (e) =>
            (!q.get('actorId') || e.actorId === q.get('actorId')) &&
            // The contract defines `action` as a prefix filter.
            (!action || e.action.toLowerCase().startsWith(action)),
        )
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      return json(200, paginate(items, q));
    },
  },
];
