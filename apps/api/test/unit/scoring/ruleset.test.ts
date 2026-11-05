import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { score } from '../../../src/modules/scoring/domain/engine.js';
import { InvalidRulesetError, parseRuleset } from '../../../src/modules/scoring/domain/ruleset.js';
import { results, testAlert } from './fixtures.js';

const RULESET_FILE = path.resolve(import.meta.dirname, '../../../config/scoring/ruleset.v1.yaml');
const shipped = () => parseRuleset(parse(readFileSync(RULESET_FILE, 'utf8')));
const now = new Date('2026-10-28T10:00:00.000Z');

const baseline = {
  fromSeverity: { informational: 0, low: 10, medium: 25, high: 40, critical: 55 },
};

function problemsOf(input: unknown): readonly string[] {
  try {
    parseRuleset(input);
  } catch (error) {
    if (error instanceof InvalidRulesetError) return error.problems;
    throw error;
  }
  return [];
}

describe('parseRuleset', () => {
  it('accepts the shipped ruleset v1', () => {
    const ruleset = shipped();
    expect(ruleset.version).toBe(1);
    expect(ruleset.rules.length).toBeGreaterThanOrEqual(10);
  });

  it('reports schema errors with their path', () => {
    expect(problemsOf({ version: 0, baseline, rules: [] })).toEqual([
      'version: Too small: expected number to be >=1',
    ]);
    expect(
      problemsOf({ version: 1, baseline: { fromSeverity: { low: 1 } }, rules: [] }).length,
    ).toBeGreaterThan(0);
  });

  it('collects every semantic problem at once', () => {
    const rule = (id: string, when: unknown, extra: object = {}) => ({
      id,
      description: id,
      when,
      points: 5,
      ...extra,
    });
    const problems = problemsOf({
      version: 1,
      baseline,
      rules: [
        rule('dup', { field: 'alert.category', op: 'eq', value: 'malware' }),
        rule('dup', { field: 'alert.category', op: 'eq', value: 'malware' }),
        rule('redos', { field: 'alert.title', op: 'matches', value: '(a+)+$' }),
        rule('typo', { field: 'enrichments.verdicts', op: 'contains', value: 'malicious' }),
        rule('typo-key', { not: { field: 'enrichment.verdict', op: 'exists' } }),
        rule(
          'bad-evidence',
          { field: 'alert.category', op: 'exists' },
          { evidenceField: 'alert.nope' },
        ),
        rule(
          'evidence-syntax',
          { field: 'alert.category', op: 'exists' },
          { evidenceField: 'not a path' },
        ),
        rule(
          'deep',
          Array.from({ length: 17 }).reduce<unknown>((inner) => ({ not: inner }), {
            field: 'alert.category',
            op: 'exists',
          }),
        ),
      ],
    });
    expect(problems).toEqual([
      'rules.1 (dup): duplicate rule id',
      'rules.2 (redos): unsafe or invalid pattern (a+)+$',
      expect.stringContaining('rules.3 (typo): unknown field "enrichments.verdicts"'),
      expect.stringContaining('rules.4 (typo-key): unknown field "enrichment.verdict"'),
      expect.stringContaining('rules.5 (bad-evidence): unknown field "alert.nope"'),
      'rules.6 (evidence-syntax): evidenceField "not a path" is not a dotted path',
      'rules.7 (deep): condition nests deeper than 16 levels',
    ]);
  });

  it('error message lists all problems', () => {
    expect(() => parseRuleset({ version: 1, baseline, rules: [{}] })).toThrow(
      /invalid scoring ruleset:\n {2}- rules\.0/,
    );
  });
});

describe('shipped ruleset v1 on realistic alerts', () => {
  it('scores credential dumping on a domain controller talking to C2 as critical', () => {
    const e = score(
      testAlert({ severity: 'high', category: 'credential_access' }),
      [results.malicious('203.0.113.66', ['c2']), results.asset('critical')],
      shipped(),
      now,
    );
    expect(e.factors.map((f) => f.ruleId)).toEqual([
      'baseline',
      'malicious-indicator',
      'known-c2-infrastructure',
      'critical-asset',
      'credential-access-tactic',
      'credential-dumping-technique',
    ]);
    expect(e).toMatchObject({ rawScore: 125, score: 100, severity: 'critical' });
  });

  it('discounts the authorized scanner', () => {
    const e = score(
      testAlert({
        severity: 'medium',
        category: 'reconnaissance',
        mitre: [{ tacticId: 'TA0043', techniqueId: 'T1595' }],
      }),
      [results.asset('medium', ['authorized-scanner'])],
      shipped(),
      now,
    );
    expect(e.factors.map((f) => f.ruleId)).toEqual(['baseline', 'authorized-scanner']);
    expect(e).toMatchObject({ rawScore: 0, score: 0, severity: 'informational' });
  });

  it('flags phishing with a malicious URL, Tor and repetition', () => {
    const e = score(
      testAlert({
        severity: 'low',
        category: 'phishing',
        duplicateCount: 12,
        mitre: [{ tacticId: 'TA0001', techniqueId: 'T1566.002' }],
      }),
      [
        {
          ...results.malicious('http://evil.example/login', ['phishing']),
          indicator: { type: 'url', value: 'http://evil.example/login' },
        },
        results.geo('198.51.100.77', 'DE', true),
      ],
      shipped(),
      now,
    );
    expect(e.factors.map((f) => [f.ruleId, f.evidence])).toEqual([
      ['baseline', 'severity=low'],
      ['malicious-indicator', 'http://evil.example/login'],
      ['tor-exit-node', '198.51.100.77'],
      ['phishing-with-malicious-url', 'http://evil.example/login'],
      ['repeated-alert', '12'],
    ]);
    expect(e.score).toBe(10 + 30 + 10 + 15 + 10);
  });
});
