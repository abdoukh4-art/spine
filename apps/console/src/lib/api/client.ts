import {
  AlertDetailSchema,
  AlertSummarySchema,
  ApprovalSchema,
  AuditEntrySchema,
  CaseSchema,
  MetricsSummarySchema,
  PlaybookDefinitionSchema,
  PlaybookRecordSchema,
  PlaybookSummarySchema,
  ProviderStatusSchema,
  RulesetSchema,
  RunDetailSchema,
  RunSummarySchema,
  SimulatedActionSchema,
  UserSchema,
  pageSchema,
  type AlertCategory,
  type AlertStatus,
  type ApprovalDecision,
  type ApprovalStatus,
  type CreateUserRequest,
  type Severity,
  type UpdateAlertRequest,
  type UpdateUserRequest,
} from '@spine/shared-schema';
import { z } from 'zod';
import type { HttpClient } from './http';

/*
 * Response shapes the contract describes in prose but `@spine/shared-schema` does not
 * export yet. They are kept local (not added to the shared package) to avoid colliding
 * with the playbooks workstream; see docs/modules/console.md, "Contract notes".
 */

/** `202 {runId}` from `POST /playbooks/:id/runs`. */
export const StartRunResponseSchema = z.object({ runId: z.uuid() });
/** `200 {valid: true, definition}` from `POST /playbooks/validate`. */
export const ValidatePlaybookResponseSchema = z.object({
  valid: z.literal(true),
  definition: PlaybookDefinitionSchema,
});
export type ValidatePlaybookResponse = z.infer<typeof ValidatePlaybookResponseSchema>;

/** Filters accepted by `GET /alerts` (all optional). */
export interface AlertListParams {
  status?: readonly AlertStatus[];
  severity?: readonly Severity[];
  minScore?: number;
  category?: AlertCategory;
  q?: string;
  technique?: string;
  assigneeId?: string;
  sort?: 'receivedAt' | 'score';
  order?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}

/** Filters accepted by `GET /runs`. */
export interface RunListParams {
  playbookId?: string;
  alertId?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

/** Filters accepted by `GET /audit-log`. */
export interface AuditListParams {
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** Simple cursor page parameters. */
export interface PageParams {
  cursor?: string;
  limit?: number;
}

const AlertPage = pageSchema(AlertSummarySchema);
const RunPage = pageSchema(RunSummarySchema);
const ApprovalPage = pageSchema(ApprovalSchema);
const SimulatedActionPage = pageSchema(SimulatedActionSchema);
const UserPage = pageSchema(UserSchema);
const AuditPage = pageSchema(AuditEntrySchema);
const CasePage = pageSchema(CaseSchema);

const enc = encodeURIComponent;

/**
 * Typed endpoint functions for every route in docs/architecture/api-contract.md that the
 * console uses. Each function is a one-liner over {@link HttpClient.request}, so the
 * schema a response is validated against is visible right next to the path.
 */
export function createSpineApi(http: HttpClient) {
  return {
    http,
    auth: {
      login: (email: string, password: string) => http.login(email, password),
      refresh: () => http.refresh(),
      logout: () => http.logout(),
      me: () => http.request({ path: '/auth/me', schema: UserSchema }),
    },
    alerts: {
      list: (params: AlertListParams = {}) =>
        http.request({ path: '/alerts', query: { ...params }, schema: AlertPage }),
      get: (id: string) => http.request({ path: `/alerts/${enc(id)}`, schema: AlertDetailSchema }),
      update: (id: string, body: UpdateAlertRequest) =>
        http.request({
          method: 'PATCH',
          path: `/alerts/${enc(id)}`,
          body,
          schema: AlertSummarySchema,
        }),
      enrich: (id: string) =>
        http.request({ method: 'POST', path: `/alerts/${enc(id)}/enrich`, schema: null }),
    },
    cases: {
      list: (params: PageParams & { status?: string } = {}) =>
        http.request({ path: '/cases', query: { ...params }, schema: CasePage }),
    },
    enrichment: {
      providers: () =>
        http.request({ path: '/enrichment/providers', schema: z.array(ProviderStatusSchema) }),
    },
    scoring: {
      ruleset: () => http.request({ path: '/scoring/ruleset', schema: RulesetSchema }),
    },
    playbooks: {
      list: () => http.request({ path: '/playbooks', schema: z.array(PlaybookSummarySchema) }),
      get: (id: string, version?: number) =>
        http.request({
          path: `/playbooks/${enc(id)}`,
          query: { version },
          schema: PlaybookRecordSchema,
        }),
      validate: (source: string, format: 'yaml' | 'json') =>
        http.request({
          method: 'POST',
          path: '/playbooks/validate',
          body: { source, format },
          schema: ValidatePlaybookResponseSchema,
        }),
      setEnabled: (id: string, enabled: boolean) =>
        http.request({
          method: 'PATCH',
          path: `/playbooks/${enc(id)}`,
          body: { enabled },
          schema: PlaybookSummarySchema,
        }),
      startRun: (id: string, alertId: string, dryRun: boolean) =>
        http.request({
          method: 'POST',
          path: `/playbooks/${enc(id)}/runs`,
          body: { alertId, dryRun },
          schema: StartRunResponseSchema,
        }),
    },
    runs: {
      list: (params: RunListParams = {}) =>
        http.request({ path: '/runs', query: { ...params }, schema: RunPage }),
      get: (id: string) => http.request({ path: `/runs/${enc(id)}`, schema: RunDetailSchema }),
      cancel: (id: string) =>
        http.request({ method: 'POST', path: `/runs/${enc(id)}/cancel`, schema: null }),
    },
    approvals: {
      list: (params: PageParams & { status?: ApprovalStatus } = {}) =>
        http.request({ path: '/approvals', query: { ...params }, schema: ApprovalPage }),
      decide: (id: string, body: ApprovalDecision) =>
        http.request({
          method: 'POST',
          path: `/approvals/${enc(id)}/decision`,
          body,
          schema: ApprovalSchema,
        }),
    },
    simulatedActions: {
      list: (params: PageParams & { kind?: string } = {}) =>
        http.request({
          path: '/simulated-actions',
          query: { ...params },
          schema: SimulatedActionPage,
        }),
    },
    metrics: {
      summary: (params: { from?: string; to?: string } = {}) =>
        http.request({
          path: '/metrics/summary',
          query: { ...params },
          schema: MetricsSummarySchema,
        }),
    },
    users: {
      list: (params: PageParams = {}) =>
        http.request({ path: '/users', query: { ...params }, schema: UserPage }),
      create: (body: CreateUserRequest) =>
        http.request({ method: 'POST', path: '/users', body, schema: UserSchema }),
      update: (id: string, body: UpdateUserRequest) =>
        http.request({ method: 'PATCH', path: `/users/${enc(id)}`, body, schema: UserSchema }),
    },
    audit: {
      list: (params: AuditListParams = {}) =>
        http.request({ path: '/audit-log', query: { ...params }, schema: AuditPage }),
    },
  };
}

/** The console's API surface. Components get it from {@link useApi}. */
export type SpineApi = ReturnType<typeof createSpineApi>;
