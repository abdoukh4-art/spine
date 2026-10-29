import { z } from 'zod';
import {
  AlertCategorySchema,
  AlertSchema,
  AlertStatusSchema,
  CanonicalAlertInputSchema,
  MitreMappingSchema,
} from './alert.js';
import { IdSchema, SeveritySchema, TimestampSchema } from './common.js';
import { EnrichmentResultSchema } from './enrichment.js';
import { RunSummarySchema } from './playbook.js';
import { ScoreExplanationSchema } from './scoring.js';

// Request/response DTOs for the HTTP API (docs/architecture/api-contract.md).

// ---------- ingestion ----------

/** `202` body of every single-alert ingest: the alert's ID and whether it was new or a duplicate. */
export const IngestResultSchema = z.object({
  alertId: IdSchema,
  status: z.enum(['created', 'deduplicated']),
  /** Present when status = deduplicated: the open alert this occurrence was merged into. */
  duplicateOf: IdSchema.optional(),
});
export type IngestResult = z.infer<typeof IngestResultSchema>;

/** Line formats accepted by `POST /ingest/batch`: canonical NDJSON, CEF syslog lines, Suricata EVE. */
export const BATCH_FORMATS = ['ndjson', 'cef', 'suricata-eve'] as const;
/** Validates a {@link BATCH_FORMATS} value. */
export const BatchFormatSchema = z.enum(BATCH_FORMATS);
export type BatchFormat = z.infer<typeof BatchFormatSchema>;

/** `POST /ingest/batch` query: `?format=` (default `ndjson`). */
export const BatchQuerySchema = z.object({ format: BatchFormatSchema.default('ndjson') });

/** Batch import outcome: counts per result plus up to 100 per-line errors (the rest still ingest). */
export const BatchResultSchema = z.object({
  accepted: z.number().int(),
  deduplicated: z.number().int(),
  rejected: z.number().int(),
  /**
   * Lines that were well-formed but not alerts (e.g. Suricata `flow`/`dns` telemetry in an EVE
   * file). Added in Phase 1 (additive): they are neither ingested nor errors.
   */
  skipped: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })).max(100),
});
export type BatchResult = z.infer<typeof BatchResultSchema>;

// ---------- alerts ----------

/**
 * One row of the alert queue: the fields the console lists, sorts and filters on, including the
 * score projection (`score`/`severity`, null until scored).
 */
export const AlertSummarySchema = z.object({
  id: IdSchema,
  title: z.string(),
  category: AlertCategorySchema,
  status: AlertStatusSchema,
  sourceSeverity: SeveritySchema,
  /** Derived from the score once scored; null while the pipeline is still running. */
  severity: SeveritySchema.nullable(),
  score: z.number().int().nullable(),
  source: z.object({ vendor: z.string(), product: z.string() }),
  occurredAt: TimestampSchema,
  receivedAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  duplicateCount: z.number().int(),
  assigneeId: IdSchema.nullable(),
  caseId: IdSchema.nullable(),
  mitre: z.array(MitreMappingSchema),
  resolvedAt: TimestampSchema.nullable(),
});
export type AlertSummary = z.infer<typeof AlertSummarySchema>;

/** `GET /alerts/:id`: the full alert with its enrichments, score explanation and playbook runs. */
export const AlertDetailSchema = z.object({
  summary: AlertSummarySchema,
  alert: AlertSchema,
  enrichments: z.array(EnrichmentResultSchema),
  score: ScoreExplanationSchema.nullable(),
  runs: z.array(RunSummarySchema),
});
export type AlertDetail = z.infer<typeof AlertDetailSchema>;

/**
 * `GET /alerts` filters and sorting. `status`/`severity` accept one value or a repeated parameter;
 * `q` is a text search on the title; pagination is by cursor (ADR-0024).
 */
export const AlertListQuerySchema = z.object({
  status: z
    .union([AlertStatusSchema, z.array(AlertStatusSchema)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  severity: z
    .union([SeveritySchema, z.array(SeveritySchema)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  category: AlertCategorySchema.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  source: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
  assigneeId: IdSchema.optional(),
  technique: z.string().max(20).optional(),
  sort: z.enum(['receivedAt', 'score']).default('receivedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type AlertListQuery = z.infer<typeof AlertListQuerySchema>;

/**
 * `PATCH /alerts/:id` (analyst): change status (validated against the allowed transitions),
 * assignee or case. `null` clears the assignee or case.
 */
export const UpdateAlertRequestSchema = z
  .object({
    status: AlertStatusSchema.optional(),
    assigneeId: IdSchema.nullable().optional(),
    caseId: IdSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type UpdateAlertRequest = z.infer<typeof UpdateAlertRequestSchema>;

// ---------- cases ----------

/** Lifecycle of a case (a group of related alerts under investigation). */
export const CASE_STATUSES = ['open', 'in_progress', 'closed'] as const;
/** Validates a {@link CASE_STATUSES} value. */
export const CaseStatusSchema = z.enum(CASE_STATUSES);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

/** A case: a titled investigation grouping alerts, with its own status. */
export const CaseSchema = z.object({
  id: IdSchema,
  title: z.string(),
  description: z.string().nullable(),
  status: CaseStatusSchema,
  alertIds: z.array(IdSchema),
  createdBy: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Case = z.infer<typeof CaseSchema>;

/** `GET /cases/:id`: the case plus summaries of its linked alerts. */
export const CaseDetailSchema = CaseSchema.extend({ alerts: z.array(AlertSummarySchema) });
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

/** `GET /cases` query: optional status filter + cursor pagination (ADR-0024). */
export const CaseListQuerySchema = z.object({
  status: CaseStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type CaseListQuery = z.infer<typeof CaseListQuerySchema>;

/** `POST /cases` (analyst): title, optional description and alerts to link immediately. */
export const CreateCaseRequestSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).optional(),
  alertIds: z.array(IdSchema).max(500).default([]),
});
export type CreateCaseRequest = z.infer<typeof CreateCaseRequestSchema>;

/** `PATCH /cases/:id` (analyst): edit fields and link or unlink alerts in one call. */
export const UpdateCaseRequestSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(10_000).optional(),
    status: CaseStatusSchema.optional(),
    addAlertIds: z.array(IdSchema).max(500).optional(),
    removeAlertIds: z.array(IdSchema).max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type UpdateCaseRequest = z.infer<typeof UpdateCaseRequestSchema>;

// ---------- playbooks ----------

/**
 * Body for validating or publishing a playbook: its YAML (or JSON) source. Parsed with tags
 * rejected and aliases capped (ADR-0013), then validated as a DAG.
 */
export const PlaybookSourceRequestSchema = z.object({
  source: z.string().min(1).max(200_000),
  format: z.enum(['yaml', 'json']).default('yaml'),
});
export type PlaybookSourceRequest = z.infer<typeof PlaybookSourceRequestSchema>;

/** `POST /playbooks/:id/runs` (analyst): run against an alert, optionally as a side-effect-free dry run. */
export const StartRunRequestSchema = z.object({
  alertId: IdSchema,
  dryRun: z.boolean().default(false),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

/** `GET /runs` filters (playbook, alert, status) with cursor pagination. */
export const RunListQuerySchema = z.object({
  playbookId: z.string().max(63).optional(),
  alertId: IdSchema.optional(),
  status: z.string().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type RunListQuery = z.infer<typeof RunListQuerySchema>;

// ---------- enrichment & scoring ----------

/** Path parameters of `/alerts/:id/...` routes. */
export const AlertIdParamsSchema = z.object({ id: IdSchema });
export type AlertIdParams = z.infer<typeof AlertIdParamsSchema>;

/** `202` body of `POST /alerts/:id/enrich`: the alert's enrichment after the re-run (stored, merged view). */
export const ReEnrichResponseSchema = z.object({
  alertId: IdSchema,
  enrichments: z.array(EnrichmentResultSchema),
});
export type ReEnrichResponse = z.infer<typeof ReEnrichResponseSchema>;

/**
 * Body of `POST /scoring/preview`. `alert` may be a stored `Alert` (as returned by
 * `GET /alerts/:id`) or a bare `CanonicalAlertInput`; identity/lifecycle fields missing
 * from the latter are filled with neutral placeholders (duplicateCount 0, status new).
 */
export const ScorePreviewRequestSchema = z.object({
  alert: z.union([AlertSchema, CanonicalAlertInputSchema]),
  enrichments: z.array(EnrichmentResultSchema).max(2000).default([]),
});
export type ScorePreviewRequest = z.infer<typeof ScorePreviewRequestSchema>;

// ---------- health ----------

/** `GET /healthz` (liveness): the process is up. It never checks dependencies. */
export const HealthSchema = z.object({ status: z.literal('ok') });
/** `GET /readyz`: ready only when every check (database, Redis, migrations, ingest backlog) passes. */
export const ReadinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});
export type Readiness = z.infer<typeof ReadinessSchema>;
