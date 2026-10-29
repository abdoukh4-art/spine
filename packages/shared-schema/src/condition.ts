import { z } from 'zod';

/**
 * The closed predicate language shared by playbook branches/triggers (ADR-0013)
 * and scoring rules (ADR-0015). There is deliberately no expression evaluation:
 * a condition is data, interpreted by a small, property-tested evaluator.
 */
export const CONDITION_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'exists',
  'matches',
] as const;
/** Validates a {@link CONDITION_OPS} value. */
export const ConditionOpSchema = z.enum(CONDITION_OPS);
export type ConditionOp = z.infer<typeof ConditionOpSchema>;

/** A JSON scalar usable as a comparison operand. */
export const ScalarSchema = z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof ScalarSchema>;

/** Dotted path into the evaluation context, e.g. `alert.host.hostname` or `score.value`. */
export const FieldPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, 'must be a dotted identifier path');

/**
 * A leaf predicate: compare the value at `field` with `value` using `op`. Declared by hand
 * (not `z.infer`) because {@link Condition} is recursive.
 */
export interface FieldCondition {
  field: string;
  op: ConditionOp;
  value?: Scalar | Scalar[] | undefined;
}
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | FieldCondition;

/** Validates a {@link FieldCondition}; `value` may be a scalar or a list (for `in`). */
export const FieldConditionSchema = z
  .object({
    field: FieldPathSchema,
    op: ConditionOpSchema,
    value: z.union([ScalarSchema, z.array(ScalarSchema).max(256)]).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.op !== 'exists' && c.value === undefined) {
      ctx.addIssue({ code: 'custom', message: `operator "${c.op}" requires a value` });
    }
    if (c.op === 'in' && !Array.isArray(c.value)) {
      ctx.addIssue({ code: 'custom', message: 'operator "in" requires an array value' });
    }
    if (c.op === 'matches' && (typeof c.value !== 'string' || c.value.length > 200)) {
      ctx.addIssue({
        code: 'custom',
        message: 'operator "matches" requires a pattern of at most 200 chars',
      });
    }
  });

/**
 * Recursive condition schema. Nesting depth is bounded by the evaluator (max 16).
 * The `id` metadata makes OpenAPI generation emit it once as `#/components/schemas/Condition`
 * and reference it, instead of a dangling `$ref` for the recursion.
 */
export const ConditionSchema: z.ZodType<Condition> = z
  .lazy(() =>
    z.union([
      z.object({ all: z.array(ConditionSchema).min(1).max(64) }).strict(),
      z.object({ any: z.array(ConditionSchema).min(1).max(64) }).strict(),
      z.object({ not: ConditionSchema }).strict(),
      FieldConditionSchema,
    ]),
  )
  .meta({
    id: 'Condition',
    description: 'A condition of the shared predicate language (ADR-0013)',
  });
