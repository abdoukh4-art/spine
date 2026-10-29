import { z } from 'zod';
import { AlertSchema, AlertStatusSchema } from './alert.js';
import { IdSchema, RoleSchema, TimestampSchema } from './common.js';
import { EnrichmentResultSchema } from './enrichment.js';
import { RunStatusSchema } from './playbook.js';
import { ScoreExplanationSchema } from './scoring.js';

/**
 * Domain event catalog (ADR-0009, docs/architecture/event-catalog.md).
 * Each entry maps an event type to its payload schema. Payloads carry snapshots so
 * consumers never need to read the producer's tables.
 */
export const EventPayloadSchemas = {
  'alert.ingested': z.object({ alert: AlertSchema }),
  'alert.deduplicated': z.object({
    alertId: IdSchema,
    fingerprint: z.string(),
    duplicateCount: z.number().int(),
    lastSeenAt: TimestampSchema,
  }),
  'alert.enriched': z.object({
    alert: AlertSchema,
    enrichments: z.array(EnrichmentResultSchema),
  }),
  'alert.scored': z.object({
    alert: AlertSchema,
    enrichments: z.array(EnrichmentResultSchema),
    score: ScoreExplanationSchema,
  }),
  'alert.status_changed': z.object({
    alertId: IdSchema,
    from: AlertStatusSchema,
    to: AlertStatusSchema,
    actorId: IdSchema.nullable(),
    at: TimestampSchema,
  }),
  'playbook.run.requested': z.object({
    runId: IdSchema,
    playbookId: z.string(),
    version: z.number().int(),
    alertId: IdSchema,
    dryRun: z.boolean(),
    trigger: z.enum(['auto', 'manual']),
  }),
  'playbook.run.finished': z.object({
    runId: IdSchema,
    playbookId: z.string(),
    alertId: IdSchema,
    status: RunStatusSchema,
    dryRun: z.boolean(),
    durationMs: z.number().int(),
  }),
  'approval.requested': z.object({
    approvalId: IdSchema,
    runId: IdSchema,
    stepId: z.string(),
    approverRole: RoleSchema,
    prompt: z.string(),
    expiresAt: TimestampSchema,
  }),
  'approval.decided': z.object({
    approvalId: IdSchema,
    runId: IdSchema,
    decision: z.enum(['approved', 'rejected', 'expired']),
    decidedBy: IdSchema.nullable(),
  }),
} as const;

/** Name of a domain event in the catalog (docs/architecture/event-catalog.md), e.g. `alert.scored`. */
export type EventType = keyof typeof EventPayloadSchemas;
/** The payload type of event `T`, inferred from its schema in the catalog. */
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloadSchemas)[T]>;

/** Envelope for every domain event. */
export interface DomainEvent<T extends EventType = EventType> {
  eventId: string;
  type: T;
  version: number;
  aggregateId: string;
  occurredAt: string;
  payload: EventPayload<T>;
  traceparent?: string;
}

/** Every event type in the catalog (handy for exhaustive tests and subscriptions). */
export const EVENT_TYPES = Object.keys(EventPayloadSchemas) as EventType[];

/** Validates an event payload against the catalog. Throws a ZodError on mismatch. */
export function parseEventPayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return EventPayloadSchemas[type].parse(payload) as EventPayload<T>;
}
