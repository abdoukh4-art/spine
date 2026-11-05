import { z } from 'zod';

/**
 * Sigma rules (https://github.com/SigmaHQ/sigma-specification, rules specification 2.x) as Spine
 * reads them for its **rule catalog** (ADR-0098). Spine never evaluates `detection`: it is a SOAR,
 * not a SIEM. It uses a rule's metadata to enrich alerts that a Sigma-based detection raised.
 * Fields Spine doesn't use are accepted and ignored (`looseObject`), as the spec allows.
 */

/** Rule criticality, per the Sigma specification (`informational` … `critical`). */
export const SIGMA_LEVELS = ['informational', 'low', 'medium', 'high', 'critical'] as const;

/** Rule maturity, per the Sigma specification. */
export const SIGMA_STATUSES = [
  'stable',
  'test',
  'experimental',
  'deprecated',
  'unsupported',
] as const;

/**
 * A Sigma detection rule. Spine requires `id` (the spec only recommends it) because the catalog is
 * keyed by it, and requires `detection` to exist so correlation rules and filters aren't mistaken
 * for detection rules.
 */
export const SigmaRuleSchema = z.looseObject({
  title: z.string().min(1).max(256),
  id: z.uuid(),
  status: z.enum(SIGMA_STATUSES).optional(),
  description: z.string().max(65_535).optional(),
  references: z.array(z.string().max(2048)).max(100).optional(),
  author: z.string().max(256).optional(),
  /** Tags such as `attack.t1059.001` or `attack.execution` (spec pattern `namespace.value`). */
  tags: z
    .array(z.string().regex(/^[a-z0-9_-]+\.[a-z0-9._-]+$/, 'must look like namespace.value'))
    .max(100)
    .optional(),
  logsource: z.looseObject({
    category: z.string().optional(),
    product: z.string().optional(),
    service: z.string().optional(),
  }),
  /** Kept opaque: Spine doesn't evaluate detection logic. */
  detection: z.record(z.string(), z.unknown()),
  falsepositives: z.array(z.string().max(1024)).max(100).optional(),
  level: z.enum(SIGMA_LEVELS).optional(),
});
export type SigmaRule = z.infer<typeof SigmaRuleSchema>;
