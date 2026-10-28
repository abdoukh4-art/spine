import { z } from 'zod';
import { IdSchema, SeveritySchema, TimestampSchema } from './common.js';

/**
 * Canonical alert schema (ADR-0011). Every ingestion source is normalized into
 * `CanonicalAlertInput` at the edge; downstream modules only ever see this shape.
 */

export const ALERT_CATEGORIES = [
  'malware',
  'phishing',
  'intrusion',
  'credential_access',
  'lateral_movement',
  'exfiltration',
  'command_and_control',
  'reconnaissance',
  'policy_violation',
  'vulnerability',
  'other',
] as const;
export const AlertCategorySchema = z.enum(ALERT_CATEGORIES);
export type AlertCategory = z.infer<typeof AlertCategorySchema>;

export const INDICATOR_TYPES = [
  'ipv4',
  'ipv6',
  'domain',
  'url',
  'sha256',
  'sha1',
  'md5',
  'email',
  'hostname',
  'username',
] as const;
export const IndicatorTypeSchema = z.enum(INDICATOR_TYPES);
export type IndicatorType = z.infer<typeof IndicatorTypeSchema>;

/** An observable (IOC candidate) extracted from or attached to an alert. */
export const IndicatorSchema = z.object({
  type: IndicatorTypeSchema,
  value: z.string().min(1).max(2048),
});
export type Indicator = z.infer<typeof IndicatorSchema>;

/** MITRE ATT&CK mapping. IDs are validated; names are informational. */
export const MitreMappingSchema = z.object({
  tacticId: z
    .string()
    .regex(/^TA\d{4}$/, 'must look like TA0001')
    .optional(),
  tacticName: z.string().max(100).optional(),
  techniqueId: z.string().regex(/^T\d{4}(\.\d{3})?$/, 'must look like T1059 or T1059.001'),
  techniqueName: z.string().max(200).optional(),
});
export type MitreMapping = z.infer<typeof MitreMappingSchema>;

const ShortText = z.string().max(512);
const IpSchema = z.union([z.ipv4(), z.ipv6()]);
const PortSchema = z.number().int().min(0).max(65535);

export const AlertSourceSchema = z.object({
  vendor: z.string().min(1).max(100),
  product: z.string().min(1).max(100),
  /** Stable ID of the alert in the source system; drives deduplication when present (ADR-0012). */
  sourceAlertId: z.string().min(1).max(256).optional(),
});
export type AlertSource = z.infer<typeof AlertSourceSchema>;

export const HostSchema = z.object({
  hostname: z.string().max(255).optional(),
  ips: z.array(IpSchema).max(32).optional(),
  os: ShortText.optional(),
});
export const UserRefSchema = z.object({
  name: z.string().max(255).optional(),
  email: z.email().optional(),
});
export const NetworkSchema = z.object({
  sourceIp: IpSchema.optional(),
  sourcePort: PortSchema.optional(),
  destinationIp: IpSchema.optional(),
  destinationPort: PortSchema.optional(),
  protocol: z.string().max(32).optional(),
});
export const FileRefSchema = z.object({
  name: z.string().max(1024).optional(),
  path: z.string().max(4096).optional(),
  sha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  md5: z
    .string()
    .regex(/^[a-fA-F0-9]{32}$/)
    .optional(),
});

/** Maximum size of the preserved raw payload, in bytes of JSON (ADR-0011). */
export const RAW_PAYLOAD_MAX_BYTES = 64 * 1024;

/** What a client submits (or what a normalizer produces). */
export const CanonicalAlertInputSchema = z.object({
  source: AlertSourceSchema,
  title: z.string().min(1).max(512),
  description: z.string().max(8192).optional(),
  category: AlertCategorySchema,
  severity: SeveritySchema.default('medium'),
  occurredAt: TimestampSchema,
  host: HostSchema.optional(),
  user: UserRefSchema.optional(),
  network: NetworkSchema.optional(),
  file: FileRefSchema.optional(),
  url: z.url().max(4096).optional(),
  indicators: z.array(IndicatorSchema).max(256).default([]),
  mitre: z.array(MitreMappingSchema).max(64).default([]),
  labels: z.record(z.string().max(100), z.string().max(1024)).default({}),
  raw: z.unknown().optional(),
});
/** Input type (defaults not yet applied). */
export type CanonicalAlertInput = z.input<typeof CanonicalAlertInputSchema>;
/** Parsed canonical alert (defaults applied). */
export type CanonicalAlert = z.infer<typeof CanonicalAlertInputSchema>;

export const ALERT_STATUSES = [
  'new',
  'triaged',
  'in_progress',
  'resolved',
  'false_positive',
] as const;
export const AlertStatusSchema = z.enum(ALERT_STATUSES);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

export const CLOSED_ALERT_STATUSES: readonly AlertStatus[] = ['resolved', 'false_positive'];

/** Allowed status transitions (see docs/architecture/api-contract.md). */
export const ALERT_STATUS_TRANSITIONS: Readonly<Record<AlertStatus, readonly AlertStatus[]>> = {
  new: ['triaged', 'in_progress', 'resolved', 'false_positive'],
  triaged: ['in_progress', 'resolved', 'false_positive'],
  in_progress: ['triaged', 'resolved', 'false_positive'],
  resolved: ['in_progress'],
  false_positive: ['in_progress'],
};

/** True if moving from `from` to `to` is a legal transition. */
export function isAllowedAlertTransition(from: AlertStatus, to: AlertStatus): boolean {
  return ALERT_STATUS_TRANSITIONS[from].includes(to);
}

/** A stored alert: canonical fields + identity and lifecycle fields assigned by Spine. */
export const AlertSchema = CanonicalAlertInputSchema.extend({
  id: IdSchema,
  fingerprint: z.string().length(64),
  status: AlertStatusSchema,
  receivedAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  duplicateCount: z.number().int().min(0),
});
export type Alert = z.infer<typeof AlertSchema>;
