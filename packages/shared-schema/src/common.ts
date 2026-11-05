import { z } from 'zod';

/** UUID (we generate UUIDv7 in the API; any RFC 4122 UUID is accepted on input). */
export const IdSchema = z.uuid();
export type Id = z.infer<typeof IdSchema>;

/** ISO-8601 timestamp with timezone offset, e.g. `2026-10-28T12:00:00.000Z`. */
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Severity levels, ordered from least to most severe. */
export const SEVERITIES = ['informational', 'low', 'medium', 'high', 'critical'] as const;
/** Validates a {@link SEVERITIES} value. */
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

/** Returns a number usable for ordering severities (informational = 0 … critical = 4). */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** RBAC roles, hierarchical: viewer < analyst < admin (ADR-0017). */
export const ROLES = ['viewer', 'analyst', 'admin'] as const;
/** Validates a {@link ROLES} value. */
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** True if `actual` grants at least the privileges of `required`. */
export function roleSatisfies(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/** Cursor pagination query (ADR-0024). */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/** Builds a `{ items, nextCursor }` page schema around an item schema. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
/** A page of results with the opaque cursor for the next one (`null` on the last page). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** RFC 9457 problem details (ADR-0024). */
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

/** Base URI for problem `type` values. */
export const PROBLEM_TYPE_BASE = 'https://spine.dev/problems/';
