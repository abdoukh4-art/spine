import { z } from 'zod';
import { SeveritySchema, TimestampSchema } from './common.js';

/** Summary statistics over a set of durations (ADR-0026). Null when count = 0. */
export const DurationStatSchema = z.object({
  count: z.number().int().min(0),
  meanSeconds: z.number().nullable(),
  p50Seconds: z.number().nullable(),
  p90Seconds: z.number().nullable(),
});
export type DurationStat = z.infer<typeof DurationStatSchema>;

/** `GET /metrics/summary` time window; defaults to the last 7 days when omitted. */
export const MetricsQuerySchema = z.object({
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
});
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;

/**
 * SOC metrics for a time window (ADR-0026): alert volume, MTTD, MTTR (with alerts still open),
 * and playbook outcomes, latency and approval wait.
 */
export const MetricsSummarySchema = z.object({
  window: z.object({ from: TimestampSchema, to: TimestampSchema }),
  alertVolume: z.object({
    total: z.number().int(),
    bySeverity: z.record(SeveritySchema, z.number().int()),
    byDay: z.array(z.object({ day: z.string(), count: z.number().int() })),
  }),
  mttd: DurationStatSchema.extend({ clockSkewCount: z.number().int() }),
  mttr: DurationStatSchema.extend({ openCount: z.number().int() }),
  playbooks: z.object({
    successRate: z.number().min(0).max(1).nullable(),
    runs: z.object({
      succeeded: z.number().int(),
      failed: z.number().int(),
      compensated: z.number().int(),
      cancelled: z.number().int(),
      inFlight: z.number().int(),
    }),
    latency: DurationStatSchema,
    approvalWait: DurationStatSchema,
  }),
});
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>;
