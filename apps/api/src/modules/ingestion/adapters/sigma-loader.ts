import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SigmaRuleSchema, type SigmaRule } from '@spine/shared-schema';
import { parse } from 'yaml';
import type { SigmaCatalog } from '../domain/sigma.js';

/** One or more catalog files are invalid; the message lists every problem with its file. */
export class InvalidSigmaCatalogError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid Sigma rule catalog:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'InvalidSigmaCatalogError';
  }
}

/** The loaded catalog, plus the files skipped on purpose (correlation rules, filters). */
export interface LoadedSigmaCatalog {
  catalog: SigmaCatalog;
  skipped: { file: string; reason: string }[];
}

/**
 * Loads every `*.yml` / `*.yaml` Sigma rule in `dir` (ADR-0098). Like the scoring ruleset, the
 * catalog is validated **at startup**: any invalid rule or duplicate id fails startup with all
 * problems listed, instead of a rule silently never matching. A missing directory is an empty
 * catalog. YAML aliases are refused (no billion-laughs), and dates stay strings.
 */
export function loadSigmaCatalog(dir: string): LoadedSigmaCatalog {
  const catalog = new Map<string, SigmaRule>();
  const skipped: { file: string; reason: string }[] = [];
  const problems: string[] = [];
  if (!existsSync(dir)) return { catalog, skipped };

  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort();
  for (const file of files) {
    let document: unknown;
    try {
      document = parse(readFileSync(path.join(dir, file), 'utf8'), { maxAliasCount: 0 });
    } catch (error) {
      problems.push(`${file}: not valid YAML (${(error as Error).message.split('\n')[0]})`);
      continue;
    }
    if (isObject(document) && ('correlation' in document || 'filter' in document)) {
      skipped.push({ file, reason: 'correlation rules and filters are not detection rules' });
      continue;
    }
    const parsed = SigmaRuleSchema.safeParse(document);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${file}: ${issue.path.join('.') || '<rule>'}: ${issue.message}`);
      }
      continue;
    }
    const id = parsed.data.id.toLowerCase();
    if (catalog.has(id)) {
      problems.push(`${file}: duplicate rule id ${id}`);
      continue;
    }
    catalog.set(id, parsed.data);
  }
  if (problems.length > 0) throw new InvalidSigmaCatalogError(problems);
  return { catalog, skipped };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
