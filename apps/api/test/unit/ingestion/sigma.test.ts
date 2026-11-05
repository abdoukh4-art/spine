import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CanonicalAlert, SigmaRule } from '@spine/shared-schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidSigmaCatalogError,
  loadSigmaCatalog,
} from '../../../src/modules/ingestion/adapters/sigma-loader.js';
import {
  applySigmaRule,
  attackFromSigmaTags,
} from '../../../src/modules/ingestion/domain/sigma.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/sigma');
const DEMO_CATALOG = path.resolve(import.meta.dirname, '../../../config/sigma');
const RULE_ID = '545a5da6-f103-4919-a519-e9aec1026ee4'; // the spec's own example rule

function alert(overrides: Partial<CanonicalAlert> = {}): CanonicalAlert {
  return {
    source: { vendor: 'Elastic', product: 'Security' },
    title: 'Encoded PowerShell',
    category: 'malware',
    severity: 'high',
    occurredAt: '2026-11-05T10:00:00.000Z',
    indicators: [],
    mitre: [],
    labels: {},
    ...overrides,
  };
}

const rule = (overrides: Partial<SigmaRule> = {}): SigmaRule => ({
  title: 'A Title',
  id: RULE_ID,
  status: 'test',
  tags: ['attack.defense-evasion', 'attack.t1211', 'attack.t1562.001'],
  logsource: { product: 'windows' },
  detection: { condition: 'selection' },
  falsepositives: ['a string'],
  references: ['https://123.456'],
  level: 'high',
  ...overrides,
});

describe('attackFromSigmaTags', () => {
  it('maps techniques and sub-techniques, attaching the tactic when there is exactly one', () => {
    expect(
      attackFromSigmaTags(['attack.defense-evasion', 'attack.t1211', 'attack.t1562.001']),
    ).toEqual([
      { techniqueId: 'T1211', tacticId: 'TA0005', tacticName: 'Defense Evasion' },
      { techniqueId: 'T1562.001', tacticId: 'TA0005', tacticName: 'Defense Evasion' },
    ]);
  });

  it("doesn't guess a tactic when the rule names several", () => {
    expect(
      attackFromSigmaTags(['attack.execution', 'attack.persistence', 'attack.t1053.005']),
    ).toEqual([{ techniqueId: 'T1053.005' }]);
  });

  it('ignores groups, software, other namespaces and duplicates', () => {
    expect(
      attackFromSigmaTags([
        'attack.g0016',
        'attack.s0002',
        'cve.2021-44228',
        'attack.t1059',
        'attack.t1059',
      ]),
    ).toEqual([{ techniqueId: 'T1059' }]);
  });
});

describe('applySigmaRule', () => {
  const catalog = new Map([[RULE_ID, rule()]]);

  it("merges the rule's ATT&CK and metadata into an alert that names it", () => {
    const enriched = applySigmaRule(
      alert({
        labels: { sigma_rule_id: RULE_ID.toUpperCase(), team: 'blue' },
        mitre: [{ techniqueId: 'T1211' }],
      }),
      catalog,
    );
    expect(enriched.mitre).toEqual([
      { techniqueId: 'T1211' }, // already known: not duplicated
      { techniqueId: 'T1562.001', tacticId: 'TA0005', tacticName: 'Defense Evasion' },
    ]);
    expect(enriched.labels).toEqual({
      sigma_rule_id: RULE_ID.toUpperCase(),
      team: 'blue',
      sigma_title: 'A Title',
      sigma_level: 'high',
      sigma_status: 'test',
      sigma_falsepositives: 'a string',
      sigma_references: 'https://123.456',
    });
  });

  it('strips spoofed sigma_* labels, whether or not the rule is known (anti-spoofing)', () => {
    const spoofed = { sigma_level: 'informational', sigma_title: 'nothing to see' };
    expect(applySigmaRule(alert({ labels: { ...spoofed } }), catalog).labels).toEqual({});
    const unknown = applySigmaRule(
      alert({ labels: { sigma_rule_id: '00000000-0000-4000-8000-000000000000', ...spoofed } }),
      catalog,
    );
    expect(unknown.labels).toEqual({ sigma_rule_id: '00000000-0000-4000-8000-000000000000' });
    expect(unknown.mitre).toEqual([]);
    const known = applySigmaRule(
      alert({ labels: { sigma_rule_id: RULE_ID, ...spoofed } }),
      catalog,
    );
    expect(known.labels.sigma_level).toBe('high');
    expect(known.labels.sigma_title).toBe('A Title');
  });

  it('respects the canonical limits (64 ATT&CK mappings, 1024-char labels)', () => {
    const many = Array.from({ length: 70 }, (_, i) => `attack.t${String(1000 + i)}`);
    const big = new Map([[RULE_ID, rule({ tags: many, falsepositives: ['x'.repeat(2000)] })]]);
    const enriched = applySigmaRule(alert({ labels: { sigma_rule_id: RULE_ID } }), big);
    expect(enriched.mitre).toHaveLength(64);
    expect(enriched.labels.sigma_falsepositives).toHaveLength(1024);
  });
});

describe('loadSigmaCatalog', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sigma-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files))
      writeFileSync(path.join(dir, name), content);
    return dir;
  };

  it("loads the specification's own example rule and skips its correlation rule", () => {
    const dir = tempDir({});
    copyFileSync(path.join(FIXTURES, 'spec-rule_1.yml'), path.join(dir, 'rule_1.yml'));
    copyFileSync(
      path.join(FIXTURES, 'spec-correlation-event_count.yml'),
      path.join(dir, 'corr.yml'),
    );
    const { catalog, skipped } = loadSigmaCatalog(dir);
    expect([...catalog.keys()]).toEqual([RULE_ID]);
    expect(catalog.get(RULE_ID)).toMatchObject({
      level: 'high',
      status: 'test',
      date: '2017-05-09',
    });
    expect(skipped).toEqual([
      { file: 'corr.yml', reason: 'correlation rules and filters are not detection rules' },
    ]);
  });

  it('loads the shipped demo catalog', () => {
    const { catalog } = loadSigmaCatalog(DEMO_CATALOG);
    expect([...catalog.values()].map((r) => r.title).sort()).toEqual([
      'Encoded PowerShell command line',
      'LSASS memory read by a non-system process',
    ]);
  });

  it('fails startup with every problem listed: invalid rules, duplicate ids, aliases', () => {
    const valid = `title: ok\nid: ${RULE_ID}\nlogsource: {product: windows}\ndetection: {condition: x}\n`;
    const dir = tempDir({
      'a.yml': valid,
      'b.yml': valid,
      'c.yml':
        'title: no detection\nid: not-a-uuid\nlogsource: {}\nlevel: severe\ntags: [Attack.T1059]\n',
      'd.yml': 'x: &a [1]\ny: *a\n',
    });
    const error = (() => {
      try {
        loadSigmaCatalog(dir);
        return null;
      } catch (e) {
        return e as InvalidSigmaCatalogError;
      }
    })();
    expect(error).toBeInstanceOf(InvalidSigmaCatalogError);
    const problems = error!.problems.join('\n');
    expect(problems).toMatch(/b\.yml: duplicate rule id/);
    expect(problems).toMatch(/c\.yml: id:/);
    expect(problems).toMatch(/c\.yml: detection:/);
    expect(problems).toMatch(/c\.yml: level:/);
    expect(problems).toMatch(/c\.yml: tags\.0: must look like namespace\.value/);
    expect(problems).toMatch(/d\.yml: not valid YAML/);
  });

  it('treats a missing directory as an empty catalog', () => {
    expect(loadSigmaCatalog('/nonexistent/sigma').catalog.size).toBe(0);
  });
});
