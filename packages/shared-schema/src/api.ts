import { z } from 'zod';
import {
  AlertCategorySchema,
  AlertSchema,
  AlertStatusSchema,
  MitreMappingSchema,
} from './alert.js';
import { IdSchema, SeveritySchema, TimestampSchema } from './common.js';
import { EnrichmentResultSchema } from './enrichment.js';
import { RunSummarySchema } from './playbook.js';
import { ScoreExplanationSchema } from './scoring.js';

/** Request/response DTOs for the HTTP API (docs/architecture/api-contract.md). */

// ---------- ingestion ----------

export const IngestResultSchema = z.object({
  alertId: IdSchema,
  status: z.enum(['created', 'deduplicated']),
  /** Present when status = deduplicated: the open alert this occurrence was merged into. */
  duplicateOf: IdSchema.optional(),
});
export type IngestResult = z.infer<typeof IngestResultSchema>;

export const BATCH_FORMATS = ['ndjson', 'cef', 'suricata-eve'] as const;
export const BatchFormatSchema = z.enum(BATCH_FORMATS);
export type BatchFormat = z.infer<typeof BatchFormatSchema>;

export const BatchQuerySchema = z.object({ format: BatchFormatSchema.default('ndjson') });

export const BatchResultSchema = z.object({
  accepted: z.number().int(),
  deduplicated: z.number().int(),
  rejected: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })).max(100),
});
export type BatchResult = z.infer<typeof BatchResultSchema>;

// ---------- alerts ----------

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

export const AlertDetailSchema = z.object({
  summary: AlertSummarySchema,
  alert: AlertSchema,
  enrichments: z.array(EnrichmentResultSchema),
  score: ScoreExplanationSchema.nullable(),
  runs: z.array(RunSummarySchema),
});
export type AlertDetail = z.infer<typeof AlertDetailSchema>;

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

export const UpdateAlertRequestSchema = z
  .object({
    status: AlertStatusSchema.optional(),
    assigneeId: IdSchema.nullable().optional(),
    caseId: IdSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type UpdateAlertRequest = z.infer<typeof UpdateAlertRequestSchema>;

// ---------- cases ----------

export const CASE_STATUSES = ['open', 'in_progress', 'closed'] as const;
export const CaseStatusSchema = z.enum(CASE_STATUSES);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

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

export const CreateCaseRequestSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).optional(),
  alertIds: z.array(IdSchema).max(500).default([]),
});
export type CreateCaseRequest = z.infer<typeof CreateCaseRequestSchema>;

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

export const PlaybookSourceRequestSchema = z.object({
  source: z.string().min(1).max(200_000),
  format: z.enum(['yaml', 'json']).default('yaml'),
});
export type PlaybookSourceRequest = z.infer<typeof PlaybookSourceRequestSchema>;

export const StartRunRequestSchema = z.object({
  alertId: IdSchema,
  dryRun: z.boolean().default(false),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const RunListQuerySchema = z.object({
  playbookId: z.string().max(63).optional(),
  alertId: IdSchema.optional(),
  status: z.string().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type RunListQuery = z.infer<typeof RunListQuerySchema>;

// ---------- health ----------

export const HealthSchema = z.object({ status: z.literal('ok') });
export const ReadinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});
export type Readiness = z.infer<typeof ReadinessSchema>;
