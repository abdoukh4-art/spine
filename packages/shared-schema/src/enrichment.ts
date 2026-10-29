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
/** Validates an {@link ENRICHMENT_STATUSES} value. `rejected` means the provider's bulkhead was full. */
export const EnrichmentStatusSchema = z.enum(ENRICHMENT_STATUSES);
export type EnrichmentStatus = z.infer<typeof EnrichmentStatusSchema>;

/** Statuses meaning "we could not get data" — surfaced as data gaps in score explanations. */
export const FAILED_ENRICHMENT_STATUSES: readonly EnrichmentStatus[] = [
  'error',
  'timeout',
  'circuit_open',
  'rejected',
];

/** A provider's opinion of an indicator. `unknown` when it has no data, which is not the same as `benign`. */
export const VERDICTS = ['malicious', 'suspicious', 'benign', 'unknown'] as const;
/** Validates a {@link VERDICTS} value. */
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Business criticality of an asset, from the asset inventory; `critical` raises the score (ADR-0015). */
export const ASSET_CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
/** Validates an {@link ASSET_CRITICALITIES} value. */
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
/** Geolocation of an IP: ISO country code, city, network owner (ASN/org) and whether it's a Tor exit node. */
export const GeoDataSchema = z.object({
  kind: z.literal('geo'),
  country: z.string().length(2).optional(),
  city: z.string().optional(),
  asn: z.number().int().optional(),
  org: z.string().optional(),
  isTor: z.boolean().default(false),
});
/** Inventory record for a host: owner, business unit, criticality and tags (e.g. `authorized-scanner`). */
export const AssetDataSchema = z.object({
  kind: z.literal('asset'),
  hostname: z.string(),
  owner: z.string().optional(),
  businessUnit: z.string().optional(),
  criticality: AssetCriticalitySchema,
  tags: z.array(z.string()).default([]),
});
/** Any provider payload, discriminated by `kind` (`reputation`, `geo`, `asset`). */
export const EnrichmentDataSchema = z.discriminatedUnion('kind', [
  ReputationDataSchema,
  GeoDataSchema,
  AssetDataSchema,
]);
export type EnrichmentData = z.infer<typeof EnrichmentDataSchema>;

/**
 * The result of one provider lookup for one indicator: status, optional verdict and payload, and
 * how long it took. Failed lookups are kept too: they become data gaps in the score explanation.
 */
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

/** Circuit-breaker states (ADR-0044): `closed` lets calls through, `open` fails fast, `half_open` probes. */
export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const;
/** Validates a {@link CIRCUIT_STATES} value. */
export const CircuitStateSchema = z.enum(CIRCUIT_STATES);
/** A circuit-breaker state (see {@link CIRCUIT_STATES}). */
export type CircuitState = z.infer<typeof CircuitStateSchema>;

/**
 * Live view of one enrichment provider (`GET /enrichment/providers`): supported indicator types,
 * breaker state and bulkhead load. Per process (ADR-0044).
 */
export const ProviderStatusSchema = z.object({
  name: z.string(),
  supports: z.array(z.string()),
  circuit: CircuitStateSchema,
  inFlight: z.number().int().min(0),
  queued: z.number().int().min(0),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;
