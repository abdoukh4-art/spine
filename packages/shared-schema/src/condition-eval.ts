import type { Condition, FieldCondition, Scalar } from './condition.js';

/**
 * Interpreter for the closed predicate language (ADR-0013, ADR-0015).
 *
 * Semantics, chosen to be predictable rather than clever:
 * - A missing field (undefined or null) makes every operator false except `exists`
 *   (which is false too) — so `neq` on a missing field is also false. Use `exists`
 *   or `not` explicitly when you mean "absent".
 * - Paths are own-property lookups only; `__proto__`, `prototype` and `constructor`
 *   segments never resolve (prototype-pollution / gadget defence).
 * - If a path segment hits an array and the segment is not a numeric index, the lookup
 *   maps over the array and flattens: `alert.mitre.tacticId` → `['TA0001','TA0006']`.
 * - Ordering operators compare numbers only. Anything else is false.
 * - `matches` uses a cached, pre-vetted RegExp and tests at most 4096 chars of input.
 * - Evaluation never throws on any context value; malformed input simply doesn't match.
 */

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 16;
const MAX_MATCH_INPUT = 4096;

/** Resolves a dotted path against a context object. Returns `undefined` when absent. */
export function getPath(context: unknown, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    current = step(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

function step(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) {
    if (/^\d+$/.test(segment)) return value[Number(segment)];
    const mapped = value.flatMap((item) => {
      const v = step(item, segment);
      return v === undefined ? [] : Array.isArray(v) ? (v as unknown[]) : [v];
    });
    return mapped.length > 0 ? mapped : undefined;
  }
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, segment)) {
    return (value as Record<string, unknown>)[segment];
  }
  return undefined;
}

/** Thrown when a regex pattern is rejected as potentially catastrophic (ReDoS). */
export class UnsafePatternError extends Error {
  constructor(pattern: string) {
    super(`unsafe or invalid regular expression: ${pattern}`);
    this.name = 'UnsafePatternError';
  }
}

/**
 * Heuristic ReDoS guard: rejects patterns with nested quantifiers such as `(a+)+`,
 * `(a*)*`, `(a|aa)+` and back-references. Conservative by design — it may reject some
 * safe patterns; it should never accept the classic exponential ones.
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > 200) return false;
  if (/\\\d/.test(pattern)) return false; // back-references
  // A quantified group whose body itself contains a quantifier or alternation.
  if (/\((?:[^()\\]|\\.)*[+*?|}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) return false;
  try {
    new RegExp(pattern, 'u');
  } catch {
    return false;
  }
  return true;
}

const regexCache = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    if (!isSafePattern(pattern)) throw new UnsafePatternError(pattern);
    re = new RegExp(pattern, 'u');
    if (regexCache.size > 1000) regexCache.clear();
    regexCache.set(pattern, re);
  }
  return re;
}

/** Collects every `matches` pattern in a condition (for load-time validation). */
export function collectPatterns(condition: Condition): string[] {
  if ('all' in condition) return condition.all.flatMap(collectPatterns);
  if ('any' in condition) return condition.any.flatMap(collectPatterns);
  if ('not' in condition) return collectPatterns(condition.not);
  return condition.op === 'matches' && typeof condition.value === 'string' ? [condition.value] : [];
}

/** Depth of a condition tree (a leaf has depth 1). */
export function conditionDepth(condition: Condition): number {
  if ('all' in condition) return 1 + Math.max(0, ...condition.all.map(conditionDepth));
  if ('any' in condition) return 1 + Math.max(0, ...condition.any.map(conditionDepth));
  if ('not' in condition) return 1 + conditionDepth(condition.not);
  return 1;
}

/**
 * Evaluates a condition against a read-only context.
 * @throws UnsafePatternError if a `matches` pattern is unsafe (validate at load time to avoid this).
 * @throws RangeError if nesting exceeds 16 levels.
 */
export function evaluateCondition(condition: Condition, context: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) throw new RangeError('condition nesting exceeds 16 levels');
  if ('all' in condition)
    return condition.all.every((c) => evaluateCondition(c, context, depth + 1));
  if ('any' in condition)
    return condition.any.some((c) => evaluateCondition(c, context, depth + 1));
  if ('not' in condition) return !evaluateCondition(condition.not, context, depth + 1);
  return evaluateField(condition, getPath(context, condition.field));
}

function evaluateField(c: FieldCondition, actual: unknown): boolean {
  if (actual === undefined || actual === null) return false;
  switch (c.op) {
    case 'exists':
      return true;
    case 'eq':
      return scalarEquals(actual, c.value);
    case 'neq':
      return !scalarEquals(actual, c.value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareNumbers(c.op, actual, c.value);
    case 'in':
      return Array.isArray(c.value) && c.value.some((v) => scalarEquals(actual, v));
    case 'contains':
      return contains(actual, c.value);
    case 'matches':
      return matches(actual, c.value);
  }
}

function scalarEquals(actual: unknown, expected: Scalar | Scalar[] | undefined): boolean {
  if (Array.isArray(expected) || Array.isArray(actual)) return false;
  return actual === expected;
}

function compareNumbers(
  op: 'gt' | 'gte' | 'lt' | 'lte',
  actual: unknown,
  expected: unknown,
): boolean {
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  if (Number.isNaN(actual) || Number.isNaN(expected)) return false;
  switch (op) {
    case 'gt':
      return actual > expected;
    case 'gte':
      return actual >= expected;
    case 'lt':
      return actual < expected;
    case 'lte':
      return actual <= expected;
  }
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((item) => item === expected);
  if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected);
  return false;
}

function matches(actual: unknown, pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  const re = compile(pattern);
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((v) => typeof v === 'string' && re.test(v.slice(0, MAX_MATCH_INPUT)));
}

/**
 * Renders `{{path}}` placeholders by plain path lookup (no expressions, no helpers).
 * Arrays are joined with ", ", objects are JSON-encoded, missing values render as "".
 * Output is plain text; each adapter is responsible for escaping for its medium.
 */
export function renderTemplate(template: string, context: unknown): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_m, path: string) =>
    stringify(getPath(context, path)),
  );
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(stringify).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
