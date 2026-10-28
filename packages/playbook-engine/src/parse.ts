import { isNode, parseDocument, visit } from 'yaml';
import type { ValidationIssue } from './errors.js';
import { validatePlaybook, type ValidationResult } from './validate.js';

/**
 * Turns playbook source text (YAML or JSON) into a validated definition.
 *
 * YAML is a surprisingly dangerous format to accept from users, so the parser is locked down:
 * - **No tags at all.** `!!binary`, `!!set` and custom `!tags` can turn text into non-JSON
 *   objects; playbooks only need plain maps, lists and scalars, so any explicit tag is an error.
 * - **Bounded aliases.** Anchors/aliases (`&a` / `*a`) can expand exponentially
 *   ("billion laughs"); more than {@link MAX_YAML_ALIASES} alias expansions is rejected.
 * - **Bounded size**: sources over {@link MAX_SOURCE_BYTES} are rejected before parsing.
 * - **Duplicate keys** are errors, not "last one wins".
 */

/** Largest accepted source, in UTF-8 bytes. */
export const MAX_SOURCE_BYTES = 256 * 1024;
/** Largest number of alias expansions accepted in one YAML document. */
export const MAX_YAML_ALIASES = 50;

/** Source formats accepted by {@link parsePlaybook}. */
export type PlaybookFormat = 'yaml' | 'json';

/**
 * Parses and validates playbook source. Never throws: every problem (syntax, schema or
 * graph) comes back in `errors` with a path and a message.
 */
export function parsePlaybook(source: string, format: PlaybookFormat): ValidationResult {
  const size = new TextEncoder().encode(source).byteLength;
  if (size > MAX_SOURCE_BYTES) {
    return fail('(source)', `source is ${size} bytes; the maximum is ${MAX_SOURCE_BYTES}`);
  }
  const loaded = format === 'json' ? loadJson(source) : loadYaml(source);
  if (!loaded.ok) return { valid: false, errors: loaded.errors };
  try {
    return validatePlaybook(loaded.value);
  } catch (err) {
    // Pathologically deep nesting can exhaust the stack inside the schema validator.
    if (err instanceof RangeError) return fail('(source)', 'document is nested too deeply');
    throw err;
  }
}

type Loaded = { ok: true; value: unknown } | { ok: false; errors: ValidationIssue[] };

function fail(path: string, message: string): ValidationResult {
  return { valid: false, errors: [{ path, message }] };
}

function loadJson(source: string): Loaded {
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch (err) {
    return { ok: false, errors: [{ path: '(source)', message: `invalid JSON: ${message(err)}` }] };
  }
}

function loadYaml(source: string): Loaded {
  const doc = parseDocument(source, {
    schema: 'core',
    customTags: [],
    uniqueKeys: true,
    merge: false,
    prettyErrors: true,
  });
  const errors: ValidationIssue[] = [...doc.errors, ...doc.warnings].map((e) => ({
    path: e.linePos ? `(source):${e.linePos[0].line}:${e.linePos[0].col}` : '(source)',
    message: `invalid YAML: ${e.message.split('\n')[0] ?? e.message}`,
  }));
  visit(doc, (_key, node) => {
    if (isNode(node) && typeof node.tag === 'string') {
      errors.push({ path: '(source)', message: `YAML tags are not allowed (found ${node.tag})` });
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  try {
    return { ok: true, value: doc.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown };
  } catch (err) {
    return { ok: false, errors: [{ path: '(source)', message: `invalid YAML: ${message(err)}` }] };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
