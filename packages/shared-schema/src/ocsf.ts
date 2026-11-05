import { z } from 'zod';

/**
 * The subset of an **OCSF 1.9.0 Detection Finding** (class 2004) that Spine emits from
 * `GET /alerts/:id/ocsf` (ADR-0097). It documents the response shape for clients and OpenAPI;
 * conformance to OCSF itself is checked in tests against a contract generated from the official
 * schema. Unknown keys are allowed so additive OCSF fields don't break clients.
 */
export const OcsfDetectionFindingSchema = z.looseObject({
  activity_id: z.number().int(),
  activity_name: z.string(),
  category_uid: z.literal(2),
  category_name: z.string(),
  class_uid: z.literal(2004),
  class_name: z.string(),
  type_uid: z.number().int(),
  type_name: z.string(),
  /** When Spine received the alert, epoch milliseconds. */
  time: z.number().int(),
  /** When the sensor says the activity happened, epoch milliseconds. */
  start_time: z.number().int(),
  severity_id: z.number().int(),
  severity: z.string(),
  status_id: z.number().int(),
  status: z.string(),
  message: z.string(),
  is_alert: z.boolean(),
  risk_score: z.number().int().optional(),
  risk_level_id: z.number().int().optional(),
  metadata: z.looseObject({
    version: z.string(),
    uid: z.string(),
    product: z.looseObject({ name: z.string() }),
  }),
  finding_info: z.looseObject({ uid: z.string(), title: z.string() }),
  device: z.looseObject({ type_id: z.number().int() }).optional(),
  observables: z
    .array(z.object({ name: z.string(), type_id: z.number().int(), value: z.string() }))
    .optional(),
  /** Spine-specific data with no OCSF home: the score explanation and playbook runs. */
  unmapped: z.object({ spine: z.record(z.string(), z.unknown()) }),
});
export type OcsfDetectionFinding = z.infer<typeof OcsfDetectionFindingSchema>;
