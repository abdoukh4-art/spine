import { INDICATOR_TYPES, type CanonicalAlert } from '@spine/shared-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  extractIndicators,
  MAX_INDICATORS,
  normalizeIndicator,
  normalizeIndicators,
  refang,
} from './indicators.js';

const defang = (s: string): string =>
  s.replace(/\./g, '[.]').replace(/^http/i, 'hxxp').replace(/@/g, '[@]');

/** Realistic and hostile indicator values: valid ones, defanged ones, padded ones, garbage. */
const valueArb = fc.oneof(
  fc.string(),
  fc.domain(),
  fc.webUrl(),
  fc.ipV4(),
  fc.ipV6(),
  fc.emailAddress(),
  fc.domain().map(defang),
  fc.webUrl().map(defang),
  fc.emailAddress().map(defang),
  fc.string({
    unit: fc.constantFrom(...'0123456789abcdefABCDEF'.split('')),
    minLength: 32,
    maxLength: 64,
  }),
  fc
    .tuple(fc.constantFrom(' ', '\t', ''), fc.domain())
    .map(([p, d]) => `${p}${d.toUpperCase()}.${p}`),
  fc.string({ unit: fc.constantFrom('[', ']', '.', '(', ')', '@', 'h', 'x', 'p', ':', '/') }),
  // Nested defang tokens in a URL path survive validation, so they exercise refang's fixpoint loop.
  fc
    .tuple(fc.webUrl(), fc.array(fc.constantFrom('[(.)]', '([.])', '[.]', '(.)', '[', ')', 'x')))
    .map(([u, tokens]) => `${u}/${tokens.join('')}`),
);
const indicatorArb = fc.record({ type: fc.constantFrom(...INDICATOR_TYPES), value: valueArb });
const listArb = fc.array(indicatorArb, { maxLength: 40 });

describe('refang', () => {
  it.each([
    ['hxxps://evil[.]example/a', 'https://evil.example/a'],
    ['HXXP://evil(.)example', 'http://evil.example'],
    ['user[@]corp{.}example', 'user@corp.example'],
    ['evil[dot]example', 'evil.example'],
    ['hxxps[://]evil[.]example', 'https://evil.example'],
    ['[(.)]', '.'], // one pass gives '[.]': only a fixpoint loop is idempotent
  ])('%s → %s', (input, expected) => {
    expect(refang(input)).toBe(expected);
  });
});

describe('normalizeIndicator', () => {
  it.each([
    [
      { type: 'domain', value: ' Evil[.]Example. ' },
      { type: 'domain', value: 'evil.example' },
    ],
    [
      { type: 'domain', value: 'bücher.example' },
      { type: 'domain', value: 'xn--bcher-kva.example' },
    ],
    [
      { type: 'domain', value: '203.0.113.9' },
      { type: 'ipv4', value: '203.0.113.9' },
    ],
    [
      { type: 'hostname', value: 'FIN-WS-042' },
      { type: 'hostname', value: 'fin-ws-042' },
    ],
    [
      { type: 'ipv4', value: '2001:DB8::1' },
      { type: 'ipv6', value: '2001:db8::1' },
    ],
    [
      { type: 'ipv4', value: '198[.]51[.]100[.]7' },
      { type: 'ipv4', value: '198.51.100.7' },
    ],
    [
      { type: 'url', value: 'hxxps://Evil[.]Example:443/Path?q=1' },
      { type: 'url', value: 'https://evil.example/Path?q=1' },
    ],
    [
      { type: 'email', value: 'Frank[@]Corp[.]Example' },
      { type: 'email', value: 'frank@corp.example' },
    ],
    [
      { type: 'sha256', value: 'A'.repeat(64) },
      { type: 'sha256', value: 'a'.repeat(64) },
    ],
    [
      { type: 'md5', value: ' D41D8CD98F00B204E9800998ECF8427E ' },
      { type: 'md5', value: 'd41d8cd98f00b204e9800998ecf8427e' },
    ],
    [
      { type: 'username', value: '  CORP\\Dana ' },
      { type: 'username', value: 'CORP\\Dana' },
    ],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeIndicator(input)).toEqual(expected);
  });

  it.each([
    { type: 'ipv4', value: '999.1.1.1' },
    { type: 'ipv4', value: '010.0.0.1' },
    { type: 'domain', value: 'localhost' },
    { type: 'domain', value: 'bad_-.example.123' },
    { type: 'domain', value: '-bad.example' },
    { type: 'url', value: 'javascript:alert(1)' },
    { type: 'url', value: 'not a url' },
    { type: 'email', value: 'no-at-sign' },
    { type: 'email', value: 'a@localhost' },
    { type: 'sha1', value: 'z'.repeat(40) },
    { type: 'sha256', value: 'a'.repeat(63) },
    { type: 'username', value: 'bad\u0000name' },
    { type: 'username', value: '   ' },
    { type: 'certificate', value: 'x' },
    { type: 'domain', value: 42 },
  ])('drops invalid %j', (input) => {
    expect(normalizeIndicator(input)).toBeNull();
  });
});

describe('normalizeIndicators — properties (ADR-0032)', () => {
  it('is idempotent: normalize(normalize(x)) = normalize(x)', () => {
    fc.assert(
      fc.property(listArb, (list) => {
        const once = normalizeIndicators(list);
        expect(normalizeIndicators(once)).toEqual(once);
      }),
      { numRuns: 1000 },
    );
  });

  it('never returns duplicates', () => {
    fc.assert(
      fc.property(listArb, (list) => {
        const keys = normalizeIndicators(list).map((i) => `${i.type}|${i.value}`);
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it('does not depend on input order', () => {
    fc.assert(
      fc.property(
        listArb.chain((list) =>
          fc.tuple(fc.constant(list), fc.shuffledSubarray(list, { minLength: list.length })),
        ),
        ([list, shuffled]) => {
          expect(normalizeIndicators(shuffled)).toEqual(normalizeIndicators(list));
        },
      ),
    );
  });

  it('never throws, even on hostile input, and caps the list', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ type: fc.string(), value: fc.anything() }), { maxLength: 20 }),
        (list) => {
          expect(() => normalizeIndicators(list)).not.toThrow();
        },
      ),
    );
    const many = Array.from({ length: 400 }, (_, i) => ({
      type: 'ipv4',
      value: `10.0.${Math.floor(i / 250)}.${i % 250}`,
    }));
    expect(normalizeIndicators(many)).toHaveLength(MAX_INDICATORS);
  });
});

describe('extractIndicators', () => {
  const base: CanonicalAlert = {
    source: { vendor: 'V', product: 'P' },
    title: 't',
    category: 'malware',
    severity: 'high',
    occurredAt: '2026-10-28T10:00:00.000Z',
    indicators: [],
    mitre: [],
    labels: {},
  };

  it('derives indicators from entity fields and URL hosts, plus explicit ones', () => {
    const indicators = extractIndicators({
      ...base,
      host: { hostname: 'HR-LT-007', ips: ['10.0.12.7', '2001:db8::7'] },
      user: { name: 'erin', email: 'Erin@Corp.Example' },
      network: { sourceIp: '198.51.100.14', destinationIp: '203.0.113.77' },
      file: { sha256: 'B'.repeat(64), md5: 'C'.repeat(32) },
      url: 'https://payload-cdn.example/stage2.ps1',
      indicators: [
        { type: 'url', value: 'hxxp://192.0.2.44/x' },
        { type: 'ipv4', value: '203.0.113.77' },
        { type: 'ipv4', value: '999.1.1.1' },
      ],
    });
    expect(indicators).toEqual([
      { type: 'ipv4', value: '10.0.12.7' },
      { type: 'ipv4', value: '192.0.2.44' },
      { type: 'ipv4', value: '198.51.100.14' },
      { type: 'ipv4', value: '203.0.113.77' },
      { type: 'ipv6', value: '2001:db8::7' },
      { type: 'domain', value: 'payload-cdn.example' },
      { type: 'url', value: 'http://192.0.2.44/x' },
      { type: 'url', value: 'https://payload-cdn.example/stage2.ps1' },
      { type: 'sha256', value: 'b'.repeat(64) },
      { type: 'md5', value: 'c'.repeat(32) },
      { type: 'email', value: 'erin@corp.example' },
      { type: 'hostname', value: 'hr-lt-007' },
      { type: 'username', value: 'erin' },
    ]);
  });

  it('returns an empty list for an alert without observables', () => {
    expect(extractIndicators(base)).toEqual([]);
  });
});
