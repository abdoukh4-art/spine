import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely row types — hand-written next to the SQL migrations (ADR-0006).
 * One interface per table; each table is owned by exactly one module (see
 * docs/architecture/data-model.md). Other modules must not query tables they don't own.
 *
 * Conventions:
 * - `Timestamp`: pg returns `Date`; we accept `Date | string` on write.
 * - `Json<T>`: jsonb columns are written as `JSON.stringify(value)` (node-postgres would
 *   otherwise turn JS arrays into Postgres arrays), and read back as parsed values.
 * - `Int8`: bigint columns come back as strings from node-postgres (no precision loss).
 */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type Json<T = unknown> = ColumnType<T, string, string>;
export type Int8 = ColumnType<string, number | bigint | string, number | bigint | string>;
/** Columns with a database default: optional on insert. */
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type GeneratedInt8 = ColumnType<
  string,
  number | bigint | string | undefined,
  number | bigint | string
>;
export type GeneratedJson<T = unknown> = ColumnType<T, string | undefined, string>;

// ---------------------------------------------------------------- platform
export interface DomainEventsTable {
  id: GeneratedInt8;
  event_id: string;
  type: string;
  version: Generated<number>;
  aggregate_id: string;
  payload: Json;
  traceparent: string | null;
  occurred_at: GeneratedTimestamp;
  dispatched_at: Timestamp | null;
  attempts: Generated<number>;
}
export interface SchemaMigrationsTable {
  filename: string;
  checksum: string;
  applied_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------- auth
export interface UsersTable {
  id: string;
  email: string;
  display_name: string;
  role: 'viewer' | 'analyst' | 'admin';
  password_hash: string;
  disabled: Generated<boolean>;
  created_at: GeneratedTimestamp;
  last_login_at: Timestamp | null;
}
export interface RefreshTokensTable {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: Buffer;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  replaced_by: string | null;
  created_at: GeneratedTimestamp;
}
export interface AuditLogTable {
  id: GeneratedInt8;
  occurred_at: GeneratedTimestamp;
  actor_id: string | null;
  actor_type: 'user' | 'system' | 'webhook' | 'anonymous';
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome_status: number | null;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details: GeneratedJson<Record<string, unknown>>;
}

// ---------------------------------------------------------------- alerts / cases
export interface CasesTable {
  id: string;
  title: string;
  description: string | null;
  status: Generated<'open' | 'in_progress' | 'closed'>;
  created_by: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface AlertsTable {
  id: string;
  fingerprint: string;
  status: Generated<'new' | 'triaged' | 'in_progress' | 'resolved' | 'false_positive'>;
  title: string;
  category: string;
  source_vendor: string;
  source_product: string;
  source_severity: string;
  score: number | null;
  severity: string | null;
  /** computedAt of the score last applied by the projection (migration 0201, ADR-0038). */
  scored_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  occurred_at: Timestamp;
  received_at: Timestamp;
  last_seen_at: Timestamp;
  resolved_at: Timestamp | null;
  duplicate_count: Generated<number>;
  assignee_id: string | null;
  case_id: string | null;
  canonical: Json;
  mitre_technique_ids: Generated<string[]>;
  mitre_tactic_ids: Generated<string[]>;
  updated_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------- ingestion
export interface IdempotencyKeysTable {
  scope: string;
  key: string;
  request_hash: Buffer;
  response_status: number;
  response_body: Json;
  created_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------- enrichment
export interface AlertEnrichmentsTable {
  alert_id: string;
  provider: string;
  indicator_type: string;
  indicator_value: string;
  status: string;
  verdict: string | null;
  data: Json | null;
  error: string | null;
  duration_ms: number;
  fetched_at: Timestamp;
}
/** Inbox of processed `alert.ingested` deliveries (migration 0401, ADR-0040). */
export interface EnrichmentProcessedEventsTable {
  event_id: string;
  alert_id: string;
  processed_at: Timestamp;
}

// ---------------------------------------------------------------- scoring
export interface AlertScoresTable {
  alert_id: string;
  ruleset_version: number;
  score: number;
  severity: string;
  explanation: Json;
  computed_at: Timestamp;
  /** `occurredAt` of the enrichment snapshot the score was computed from (migration 0501). */
  source_occurred_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------- playbooks
export interface PlaybooksTable {
  id: string;
  version: number;
  name: string;
  enabled: Generated<boolean>;
  definition: Json;
  source: string;
  created_by: string | null;
  created_at: GeneratedTimestamp;
}
export interface PlaybookRunsTable {
  id: string;
  playbook_id: string;
  playbook_version: number;
  alert_id: string;
  dry_run: Generated<boolean>;
  status: string;
  current_step_id: string | null;
  trigger: 'auto' | 'manual';
  started_by: string | null;
  last_seq: Generated<number>;
  created_at: GeneratedTimestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  approval_wait_ms: GeneratedInt8;
}
export interface PlaybookRunEventsTable {
  run_id: string;
  seq: number;
  type: string;
  step_id: string | null;
  payload: GeneratedJson<Record<string, unknown>>;
  occurred_at: GeneratedTimestamp;
}
export interface ApprovalsTable {
  id: string;
  run_id: string;
  step_id: string;
  alert_id: string;
  playbook_id: string;
  status: Generated<'pending' | 'approved' | 'rejected' | 'expired'>;
  approver_role: string;
  prompt: string;
  decided_by: string | null;
  comment: string | null;
  requested_at: GeneratedTimestamp;
  expires_at: Timestamp;
  decided_at: Timestamp | null;
}
export interface SimulatedActionsTable {
  id: string;
  kind: string;
  idempotency_key: string;
  run_id: string | null;
  step_id: string | null;
  request: Json<Record<string, unknown>>;
  response: Json<Record<string, unknown>>;
  dry_run: Generated<boolean>;
  created_at: GeneratedTimestamp;
}

/** The full database as seen by Kysely. */
export interface Database {
  domain_events: DomainEventsTable;
  schema_migrations: SchemaMigrationsTable;
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  audit_log: AuditLogTable;
  cases: CasesTable;
  alerts: AlertsTable;
  idempotency_keys: IdempotencyKeysTable;
  alert_enrichments: AlertEnrichmentsTable;
  enrichment_processed_events: EnrichmentProcessedEventsTable;
  alert_scores: AlertScoresTable;
  playbooks: PlaybooksTable;
  playbook_runs: PlaybookRunsTable;
  playbook_run_events: PlaybookRunEventsTable;
  approvals: ApprovalsTable;
  simulated_actions: SimulatedActionsTable;
}
