import { z } from 'zod';
import { IndicatorSchema } from './alert.js';
import { TimestampSchema } from './common.js';

/** Outcome of one provider lookup for one indicator (ADR-0014). */
export const ENRICHMENT_STATUSES = [
  'ok',
  'not_found',
  'skipped',
  'error',
  'timeout',
  'circuit_open',
  'rejected',
] as const;
export const EnrichmentStatusSchema = z.enum(ENRICHMENT_STATUSES);
export type EnrichmentStatus = z.infer<typeof EnrichmentStatusSchema>;

/** Statuses meaning "we could not get data" — surfaced as data gaps in score explanations. */
export const FAILED_ENRICHMENT_STATUSES: readonly EnrichmentStatus[] = [
  'error',
  'timeout',
  'circuit_open',
  'rejected',
];

export const VERDICTS = ['malicious', 'suspicious', 'benign', 'unknown'] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ASSET_CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export const AssetCriticalitySchema = z.enum(ASSET_CRITICALITIES);
export type AssetCriticality = z.infer<typeof AssetCriticalitySchema>;

/** Provider-specific payloads. Kept small and typed so scoring rules can reference them. */
export const ReputationDataSchema = z.object({
  kind: z.literal('reputation'),
  score: z.number().min(0).max(100),
  verdict: VerdictSchema,
  tags: z.array(z.string()).default([]),
  firstSeen: TimestampSchema.optional(),
});
export const GeoDataSchema = z.object({
  kind: z.literal('geo'),
  country: z.string().length(2).optional(),
  city: z.string().optional(),
  asn: z.number().int().optional(),
  org: z.string().optional(),
  isTor: z.boolean().default(false),
});
export const AssetDataSchema = z.object({
  kind: z.literal('asset'),
  hostname: z.string(),
  owner: z.string().optional(),
  businessUnit: z.string().optional(),
  criticality: AssetCriticalitySchema,
  tags: z.array(z.string()).default([]),
});
export const EnrichmentDataSchema = z.discriminatedUnion('kind', [
  ReputationDataSchema,
  GeoDataSchema,
  AssetDataSchema,
]);
export type EnrichmentData = z.infer<typeof EnrichmentDataSchema>;

export const EnrichmentResultSchema = z.object({
  provider: z.string().min(1).max(64),
  indicator: IndicatorSchema,
  status: EnrichmentStatusSchema,
  verdict: VerdictSchema.optional(),
  data: EnrichmentDataSchema.optional(),
  error: z.string().max(500).optional(),
  durationMs: z.number().int().min(0),
  fetchedAt: TimestampSchema,
});
export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;

export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const;
export const CircuitStateSchema = z.enum(CIRCUIT_STATES);
export type CircuitState = z.infer<typeof CircuitStateSchema>;

export const ProviderStatusSchema = z.object({
  name: z.string(),
  supports: z.array(z.string()),
  circuit: CircuitStateSchema,
  inFlight: z.number().int().min(0),
  queued: z.number().int().min(0),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;
