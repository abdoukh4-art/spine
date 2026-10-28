import { createHash } from 'node:crypto';
import { INDICATOR_TYPES } from '@spine/shared-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeFingerprint, fingerprintMaterial, normalizeTitle } from './fingerprint.js';

const indicatorArb = fc.record({
  type: fc.constantFrom(...INDICATOR_TYPES),
  value: fc.string({ minLength: 1, maxLength: 30 }),
});
const inputArb = fc.record({
  source: fc.record({ vendor: fc.string({ minLength: 1 }), product: fc.string({ minLength: 1 }) }),
  category: fc.constantFrom('malware', 'phishing', 'other'),
  title: fc.string({ minLength: 1 }),
  indicators: fc.array(indicatorArb, { maxLength: 15 }),
});

describe('fingerprint (ADR-0012)', () => {
  it('uses vendor|product|sourceAlertId when the source gives an id', () => {
    const input = {
      source: { vendor: 'OISF', product: 'Suricata', sourceAlertId: '42:2001' },
      category: 'malware',
      title: 'ignored',
      indicators: [{ type: 'ipv4' as const, value: '192.0.2.1' }],
    };
    expect(fingerprintMaterial(input)).toBe('OISF|Suricata|42:2001');
    expect(computeFingerprint(input)).toBe(
      createHash('sha256').update('OISF|Suricata|42:2001').digest('hex'),
    );
  });

  it('falls back to vendor|product|category|normalized title|sorted indicators', () => {
    expect(
      fingerprintMaterial({
        source: { vendor: 'Acme', product: 'EdgeWall' },
        category: 'intrusion',
        title: '  Brute   FORCE login ',
        indicators: [
          { type: 'username', value: 'alice' },
          { type: 'ipv4', value: '203.0.113.5' },
        ],
      }),
    ).toBe('Acme|EdgeWall|intrusion|brute force login|ipv4:203.0.113.5|username:alice');
  });

  it('escapes separators so components cannot bleed into each other', () => {
    const a = computeFingerprint({
      source: { vendor: 'a|b', product: 'c', sourceAlertId: 'x' },
      category: 'other',
      title: 't',
      indicators: [],
    });
    const b = computeFingerprint({
      source: { vendor: 'a', product: 'b|c', sourceAlertId: 'x' },
      category: 'other',
      title: 't',
      indicators: [],
    });
    expect(a).not.toBe(b);
    expect(
      fingerprintMaterial({
        source: { vendor: 'a\\', product: 'b' },
        category: 'c',
        title: 't',
        indicators: [],
      }),
    ).toBe('a\\\\|b|c|t');
  });

  it('normalizes titles with NFKC, case folding and whitespace collapsing', () => {
    expect(normalizeTitle('ＥＴ  Malware\tBeacon ')).toBe('et malware beacon');
  });

  it('property: indicator order never changes the fingerprint', () => {
    fc.assert(
      fc.property(
        inputArb.chain((input) =>
          fc.tuple(
            fc.constant(input),
            fc.shuffledSubarray(input.indicators, { minLength: input.indicators.length }),
          ),
        ),
        ([input, shuffled]) => {
          expect(computeFingerprint({ ...input, indicators: shuffled })).toBe(
            computeFingerprint(input),
          );
        },
      ),
    );
  });

  it('property: different sourceAlertIds give different fingerprints', () => {
    fc.assert(
      fc.property(
        inputArb,
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (input, id1, id2) => {
          fc.pre(id1 !== id2);
          const f1 = computeFingerprint({
            ...input,
            source: { ...input.source, sourceAlertId: id1 },
          });
          const f2 = computeFingerprint({
            ...input,
            source: { ...input.source, sourceAlertId: id2 },
          });
          expect(f1).not.toBe(f2);
          expect(f1).toMatch(/^[0-9a-f]{64}$/);
        },
      ),
    );
  });
});
