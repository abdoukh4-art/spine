import { describe, expect, it } from 'vitest';
import { canonicalLines } from '../../fixtures/index.js';
import { normalizeCanonical } from './canonical.js';
import { classifyCategory, compact, port, strings, toIsoTimestamp, zipMitre } from './fields.js';
import { NORMALIZER_NAMES, NORMALIZERS } from './index.js';

describe('toIsoTimestamp', () => {
  it.each([
    ['2026-10-28T09:12:44.123456+0000', '2026-10-28T09:12:44.123Z'],
    ['2026-10-28T11:12:44+02:00', '2026-10-28T09:12:44.000Z'],
    ['2026-10-28 09:12:44Z', '2026-10-28T09:12:44.000Z'],
    ['2026-10-28T09:12Z', '2026-10-28T09:12:00.000Z'],
    ['1793179860', '2026-10-28T09:31:00.000Z'],
    ['1793179860000', '2026-10-28T09:31:00.000Z'],
    [1793179860000, '2026-10-28T09:31:00.000Z'],
    ['Oct 28 2026 09:30:00', '2026-10-28T09:30:00.000Z'],
    ['Oct 28 2026 09:30:00.5 UTC', '2026-10-28T09:30:00.500Z'],
  ])('parses %s', (input, expected) => {
    expect(toIsoTimestamp(input)).toBe(expected);
  });

  it.each([
    ['no zone', '2026-10-28T09:12:44'],
    ['garbage', 'yesterday'],
    ['an unknown month', 'Foo 28 2026 09:30:00'],
    ['an impossible date', '2026-13-45T99:99:99Z'],
    ['a boolean', true],
    ['infinity', Number.POSITIVE_INFINITY],
    ['an empty string', '   '],
  ])('returns undefined for %s', (_name, input) => {
    expect(toIsoTimestamp(input)).toBeUndefined();
  });
});

describe('classifyCategory', () => {
  it.each([
    [['ET PHISHING Office 365 credential page'], 'phishing'],
    [['Kerberoasting detected'], 'credential_access'],
    [['PsExec service installed on remote host'], 'lateral_movement'],
    [['Large upload to cloud storage'], 'exfiltration'],
    [['Ransomware note dropped'], 'malware'],
    [['Detection of a Network Scan'], 'reconnaissance'],
    [['SQL injection attempt'], 'intrusion'],
    [['CVE-2021-44228 vulnerable library'], 'vulnerability'],
    [['Potential Corporate Privacy Violation'], 'policy_violation'],
    [[undefined, 'Something odd'], 'other'],
  ] as const)('classifies %j as %s', (texts, expected) => {
    expect(classifyCategory(texts)).toBe(expected);
  });
});

describe('zipMitre', () => {
  it('drops invalid technique ids and omits invalid tactic ids', () => {
    expect(
      zipMitre({ tacticIds: ['TA11'], techniqueIds: ['T1059.001', 'bogus', ' t1003 '] }),
    ).toEqual([{ techniqueId: 'T1059.001' }, { techniqueId: 'T1003' }]);
  });

  it('reuses the single tactic for every technique', () => {
    expect(
      zipMitre({
        tacticIds: ['TA0006'],
        tacticNames: ['Credential_Access'],
        techniqueIds: ['T1003', 'T1110'],
      }),
    ).toEqual([
      { techniqueId: 'T1003', tacticId: 'TA0006', tacticName: 'Credential Access' },
      { techniqueId: 'T1110', tacticId: 'TA0006', tacticName: 'Credential Access' },
    ]);
  });
});

describe('small field helpers', () => {
  it('parses ports, string lists and compacts objects', () => {
    expect(port('443')).toBe(443);
    expect(port(70000)).toBeUndefined();
    expect(port('x')).toBeUndefined();
    expect(strings('a')).toEqual(['a']);
    expect(strings(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(strings(3)).toEqual([]);
    expect(compact({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});

describe('canonical normalizer', () => {
  it('validates and applies defaults to fixture lines', () => {
    for (const line of canonicalLines()) {
      const r = normalizeCanonical(line);
      expect(r.ok).toBe(true);
    }
  });

  it('reports schema violations with paths', () => {
    const r = normalizeCanonical({ title: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('schema_violation');
    expect(r.error.issues?.map((i) => i.path)).toEqual(
      expect.arrayContaining(['source', 'title', 'category', 'occurredAt']),
    );
  });

  it('reports invalid JSON text', () => {
    const r = normalizeCanonical('{');
    expect(!r.ok && r.error.code).toBe('invalid_json');
  });

  it('exposes every configured normalizer in the registry', () => {
    expect(Object.keys(NORMALIZERS).sort()).toEqual([...NORMALIZER_NAMES].sort());
  });
});
