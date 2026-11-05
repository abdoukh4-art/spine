import {
  AlertSchema,
  collectPatterns,
  conditionDepth,
  FieldPathSchema,
  isSafePattern,
  RulesetSchema,
  type Condition,
  type Ruleset,
} from '@spine/shared-schema';
import { ENRICHMENT_SUMMARY_KEYS } from './evaluation-context.js';

/** Thrown when a ruleset fails validation. `problems` lists every issue found, not just the first. */
export class InvalidRulesetError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid scoring ruleset:\n  - ${problems.join('\n  - ')}`);
    this.name = 'InvalidRulesetError';
  }
}

const MAX_DEPTH = 16;
const ALERT_KEYS = new Set(Object.keys(AlertSchema.shape));
const ENRICHMENT_KEYS = new Set<string>(ENRICHMENT_SUMMARY_KEYS);

/**
 * Validates a parsed YAML/JSON document as a scoring ruleset (ADR-0015, ADR-0046).
 * Beyond the Zod schema it checks what only makes sense for a whole ruleset:
 * - rule IDs are unique (they are the stable names analysts see in explanations);
 * - every `matches` pattern passes the ReDoS guard (`isSafePattern`);
 * - conditions nest at most 16 levels;
 * - every field path starts with a real context key (`alert.<field>` or
 *   `enrichment.<summary key>`), so a typo such as `enrichments.verdicts` fails at
 *   startup instead of silently never matching.
 *
 * @throws InvalidRulesetError listing every problem.
 */
export function parseRuleset(input: unknown): Ruleset {
  const parsed = RulesetSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidRulesetError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const ruleset = parsed.data;
  const problems: string[] = [];
  const seen = new Set<string>();
  ruleset.rules.forEach((rule, index) => {
    const where = `rules.${index} (${rule.id})`;
    if (seen.has(rule.id)) problems.push(`${where}: duplicate rule id`);
    seen.add(rule.id);
    for (const pattern of collectPatterns(rule.when)) {
      if (!isSafePattern(pattern)) problems.push(`${where}: unsafe or invalid pattern ${pattern}`);
    }
    if (conditionDepth(rule.when) > MAX_DEPTH) {
      problems.push(`${where}: condition nests deeper than ${MAX_DEPTH} levels`);
    }
    for (const field of fieldPaths(rule.when)) {
      const problem = checkFieldPath(field);
      if (problem) problems.push(`${where}: ${problem}`);
    }
    if (rule.evidenceField !== undefined) {
      const problem = FieldPathSchema.safeParse(rule.evidenceField).success
        ? checkFieldPath(rule.evidenceField)
        : `evidenceField "${rule.evidenceField}" is not a dotted path`;
      if (problem) problems.push(`${where}: ${problem}`);
    }
  });
  if (problems.length > 0) throw new InvalidRulesetError(problems);
  return ruleset;
}

/** Every `field` referenced by a condition, depth first. */
export function fieldPaths(condition: Condition): string[] {
  if ('all' in condition) return condition.all.flatMap(fieldPaths);
  if ('any' in condition) return condition.any.flatMap(fieldPaths);
  if ('not' in condition) return fieldPaths(condition.not);
  return [condition.field];
}

function checkFieldPath(path: string): string | null {
  const [root, key] = path.split('.');
  if (root === 'alert' && key !== undefined && ALERT_KEYS.has(key)) return null;
  if (root === 'enrichment' && key !== undefined && ENRICHMENT_KEYS.has(key)) return null;
  return `unknown field "${path}" (must start with alert.<field> or enrichment.<key>; see docs/modules/scoring.md)`;
}
