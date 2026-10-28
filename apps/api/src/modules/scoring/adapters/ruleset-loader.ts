import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Ruleset } from '@spine/shared-schema';
import { parse } from 'yaml';
import type { Config } from '../../../platform/config.js';
import { InvalidRulesetError, parseRuleset } from '../domain/ruleset.js';

/** Absolute path of the configured ruleset file (`CONFIG_DIR`/`SCORING_RULESET_FILE`). */
export function rulesetPath(config: Pick<Config, 'CONFIG_DIR' | 'SCORING_RULESET_FILE'>): string {
  return path.resolve(config.CONFIG_DIR, config.SCORING_RULESET_FILE);
}

/**
 * Loads and validates the scoring ruleset **once, at startup** (ADR-0046). Any problem
 * (missing file, YAML syntax, schema, unsafe regex, unknown field) throws, so the process
 * refuses to start rather than scoring with a broken or partial ruleset.
 * Synchronous on purpose: it runs once during composition, before the server listens.
 *
 * @throws InvalidRulesetError
 */
export function loadRuleset(file: string): Ruleset {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new InvalidRulesetError([`cannot read ${file}: ${(error as Error).message}`]);
  }
  let document: unknown;
  try {
    document = parse(text, { maxAliasCount: 0 });
  } catch (error) {
    throw new InvalidRulesetError([`${file} is not valid YAML: ${(error as Error).message}`]);
  }
  return parseRuleset(document);
}
