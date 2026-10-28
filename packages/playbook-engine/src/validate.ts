import {
  collectPatterns,
  conditionDepth,
  isSafePattern,
  PlaybookDefinitionSchema,
  type Condition,
  type PlaybookDefinition,
  type Step,
} from '@spine/shared-schema';
import type { ValidationIssue } from './errors.js';

/**
 * Load-time validation of a playbook (ADR-0013): shape first (Zod), then the graph rules
 * a schema cannot express. Every problem is reported, not just the first one, because a
 * playbook author fixing errors one round-trip at a time is a miserable experience.
 */

/** Maximum nesting depth of a condition (matches the evaluator's limit). */
export const MAX_CONDITION_DEPTH = 16;

/** Result of validating a playbook. */
export type ValidationResult =
  | { valid: true; definition: PlaybookDefinition }
  | { valid: false; errors: ValidationIssue[] };

/** An outgoing edge of a step, with the path of the field that declares it. */
export interface Edge {
  from: string;
  to: string;
  path: string;
}

/** Formats a Zod-style path (`['steps', 3, 'next']`) as `steps[3].next`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out === '' ? '(root)' : out;
}

/**
 * Validates an already-parsed value (e.g. JSON from the API or YAML converted to JS).
 * Returns the typed definition (with defaults applied) or all problems found.
 */
export function validatePlaybook(value: unknown): ValidationResult {
  const parsed = PlaybookDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }
  const errors = validateGraph(parsed.data);
  return errors.length > 0 ? { valid: false, errors } : { valid: true, definition: parsed.data };
}

/** Lists the outgoing edges of a step, in declaration order. */
export function edgesOf(step: Step, index: number): Edge[] {
  const at = `steps[${index}]`;
  const edges: Edge[] = [];
  if (step.type === 'branch') {
    step.branches.forEach((b, k) => {
      edges.push({ from: step.id, to: b.next, path: `${at}.branches[${k}].next` });
    });
    if (step.default !== undefined) {
      edges.push({ from: step.id, to: step.default, path: `${at}.default` });
    }
    return edges;
  }
  if (step.next !== undefined) edges.push({ from: step.id, to: step.next, path: `${at}.next` });
  if (step.type === 'approval' && step.onReject !== undefined) {
    edges.push({ from: step.id, to: step.onReject, path: `${at}.onReject` });
  }
  return edges;
}

/**
 * Graph rules: unique IDs, `start` exists, every reference exists, no cycles, every step
 * reachable from `start`, and every condition is shallow enough and ReDoS-safe.
 */
export function validateGraph(definition: PlaybookDefinition): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const indexById = new Map<string, number>();
  definition.steps.forEach((step, i) => {
    const first = indexById.get(step.id);
    if (first === undefined) indexById.set(step.id, i);
    else {
      errors.push({
        path: `steps[${i}].id`,
        message: `duplicate step id "${step.id}" (first defined at steps[${first}])`,
      });
    }
  });

  if (!indexById.has(definition.start)) {
    errors.push({ path: 'start', message: `start step "${definition.start}" does not exist` });
  }

  const adjacency = new Map<string, Edge[]>();
  definition.steps.forEach((step, i) => {
    if (indexById.get(step.id) !== i) return; // duplicates were reported above
    const edges = edgesOf(step, i);
    for (const edge of edges) {
      if (!indexById.has(edge.to)) {
        errors.push({ path: edge.path, message: `references unknown step "${edge.to}"` });
      }
    }
    adjacency.set(
      step.id,
      edges.filter((e) => indexById.has(e.to)),
    );
  });

  errors.push(...findCycles(adjacency, indexById));
  if (indexById.has(definition.start)) {
    errors.push(...findUnreachable(definition.start, adjacency, indexById));
  }
  errors.push(...validateConditions(definition));
  return errors;
}

/**
 * Detects cycles with a depth-first search using three colours:
 * white = not visited, grey = on the current DFS path, black = fully explored.
 * Reaching a grey node again means we walked in a circle; the grey path is the cycle.
 */
function findCycles(
  adjacency: ReadonlyMap<string, Edge[]>,
  indexById: ReadonlyMap<string, number>,
): ValidationIssue[] {
  const colour = new Map<string, 'grey' | 'black'>();
  const path: string[] = [];
  const errors: ValidationIssue[] = [];

  const visit = (node: string): void => {
    colour.set(node, 'grey');
    path.push(node);
    for (const edge of adjacency.get(node) ?? []) {
      const c = colour.get(edge.to);
      if (c === 'grey') {
        const cycle = [...path.slice(path.indexOf(edge.to)), edge.to];
        errors.push({ path: edge.path, message: `cycle detected: ${cycle.join(' → ')}` });
      } else if (c === undefined) {
        visit(edge.to);
      }
    }
    path.pop();
    colour.set(node, 'black');
  };

  for (const id of indexById.keys()) if (!colour.has(id)) visit(id);
  return errors;
}

function findUnreachable(
  start: string,
  adjacency: ReadonlyMap<string, Edge[]>,
  indexById: ReadonlyMap<string, number>,
): ValidationIssue[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    for (const edge of adjacency.get(node) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  const errors: ValidationIssue[] = [];
  for (const [id, index] of indexById) {
    if (!seen.has(id)) {
      errors.push({
        path: `steps[${index}]`,
        message: `step "${id}" is unreachable from start "${start}"`,
      });
    }
  }
  return errors;
}

function validateConditions(definition: PlaybookDefinition): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  if (definition.trigger?.when) {
    errors.push(...checkCondition(definition.trigger.when, 'trigger.when'));
  }
  definition.steps.forEach((step, i) => {
    if (step.type !== 'branch') return;
    step.branches.forEach((b, k) => {
      errors.push(...checkCondition(b.when, `steps[${i}].branches[${k}].when`));
    });
  });
  return errors;
}

/** Checks one condition tree: bounded depth and only ReDoS-safe `matches` patterns. */
export function checkCondition(condition: Condition, path: string): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const depth = conditionDepth(condition);
  if (depth > MAX_CONDITION_DEPTH) {
    errors.push({
      path,
      message: `condition is nested ${depth} levels deep (maximum ${MAX_CONDITION_DEPTH})`,
    });
  }
  for (const pattern of collectPatterns(condition)) {
    if (!isSafePattern(pattern)) {
      errors.push({
        path,
        message: `pattern ${JSON.stringify(pattern)} is invalid or may cause catastrophic backtracking`,
      });
    }
  }
  return errors;
}
