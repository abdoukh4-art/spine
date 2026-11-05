import { describe, expect, it } from 'vitest';
import { cefLines } from '../../fixtures/index.js';
import { normalizeCef, cefSeverity } from './cef.js';
import { parseCef, parseExtensions, unescapeExtensionValue } from './cef-parser.js';

const [bruteForce, phishing, lsass, c2, lowRisk] = cefLines() as [
  string,
  string,
  string,
  string,
  string,
];

function okValue(line: string, receivedAt?: string) {
  const result = normalizeCef(line, receivedAt ? { receivedAt } : undefined);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('CEF parser', () => {
  it('splits the header on unescaped pipes and unescapes \\| and \\\\', () => {
    const r = parseCef('CEF:0|Ven\\|dor|Prod\\\\uct|1.0|42|Name with \\| pipe|5|src=192.0.2.1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.deviceVendor).toBe('Ven|dor');
    expect(r.value.deviceProduct).toBe('Prod\\uct');
    expect(r.value.name).toBe('Name with | pipe');
    expect(r.value.extensions).toEqual({ src: '192.0.2.1' });
  });

  it('parses multi-word values, escaped equals signs and line breaks', () => {
    expect(
      parseExtensions('msg=Login failed for user x\\=y act=blocked note=a\\nb path=C:\\\\tmp'),
    ).toEqual({ msg: 'Login failed for user x=y', act: 'blocked', note: 'a\nb', path: 'C:\\tmp' });
  });

  it('does not treat "=" inside a value (URL query) as a new key', () => {
    expect(parseExtensions('request=http://a.example/?q=1&r=2 dpt=80')).toEqual({
      request: 'http://a.example/?q=1&r=2',
      dpt: '80',
    });
  });

  it('tolerates syslog prefixes (RFC 3164 and RFC 5424) and keeps them aside', () => {
    const r = parseCef(bruteForce);
    expect(r.ok && r.value.prefix).toBe('<134>Oct 28 09:30:01 fw-edge-01');
    const r2 = parseCef(lsass);
    expect(r2.ok && r2.value.version).toBe(1);
  });

  it('accepts a header without extensions', () => {
    const r = parseCef('CEF:0|V|P|1|sig|Name|3');
    expect(r.ok && r.value.extensions).toEqual({});
  });

  it.each([
    ['no CEF marker', 'hello world'],
    ['too few header fields', 'CEF:0|V|P|1|sig'],
    ['a non-numeric version', 'CEF:x|V|P|1|sig|Name|3|'],
  ])('rejects %s', (_name, line) => {
    const r = parseCef(line);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('parse_error');
  });

  it('keeps unknown escapes verbatim', () => {
    expect(unescapeExtensionValue('a\\tb')).toBe('a\\tb');
  });
});

describe('CEF normalizer', () => {
  it('maps a firewall brute-force event', () => {
    const a = okValue(bruteForce);
    expect(a.source).toEqual({
      vendor: 'Acme Networks',
      product: 'EdgeWall',
      sourceAlertId: 'EW-778123',
    });
    expect(a.title).toBe('Brute force login attempt');
    expect(a.severity).toBe('high');
    expect(a.category).toBe('credential_access');
    expect(a.occurredAt).toBe('2026-10-28T09:30:00.000Z');
    expect(a.description).toBe('5 failed logins followed by a success');
    expect(a.network).toEqual({
      sourceIp: '203.0.113.5',
      sourcePort: 61022,
      destinationIp: '10.0.0.8',
      destinationPort: 22,
      protocol: 'tcp',
    });
    expect(a.user).toEqual({ name: 'svc-backup' });
    expect(a.indicators).toContainEqual({ type: 'username', value: 'alice' });
    expect(a.labels['cef.action']).toBe('blocked');
    expect(a.raw).toEqual({ format: 'cef', line: bruteForce });
  });

  it('maps a phishing event: epoch rt, email user, defanged request, MITRE from custom strings', () => {
    const a = okValue(phishing);
    expect(a.occurredAt).toBe('2026-10-28T09:31:00.000Z');
    expect(a.category).toBe('phishing');
    expect(a.severity).toBe('high');
    expect(a.user).toEqual({ name: 'bob@corp.example', email: 'bob@corp.example' });
    // hxxp is not a URL scheme, so it is not put in `url`; indicator extraction refangs it later.
    expect(a.url).toBeUndefined();
    expect(a.mitre).toEqual([{ techniqueId: 'T1566.002', tacticId: 'TA0001' }]);
    expect(a.labels.mitreTechniqueId).toBe('T1566.002');
  });

  it('maps an EDR event: ISO start, file fields, escaped backslashes', () => {
    const a = okValue(lsass);
    expect(a.severity).toBe('critical');
    expect(a.category).toBe('credential_access');
    expect(a.occurredAt).toBe('2026-10-28T09:40:58.000Z');
    expect(a.host).toEqual({ hostname: 'FIN-WS-042' });
    expect(a.user?.name).toBe('CORP\\dana');
    expect(a.file).toEqual({
      name: 'procdump64.exe',
      path: 'C:\\Users\\dana\\AppData\\Local\\Temp\\procdump64.exe',
      sha256: '0f343b0931126a20f133d67c2b018a3b5d0b3a4c2d7c9e5b1f3a8c6d4e2f1a0b',
    });
    expect(a.labels['Detection Rule']).toBe('LSASS handle with PROCESS_VM_READ');
  });

  it('maps a C2 event with an escaped pipe in the name and a multi-line message', () => {
    const a = okValue(c2);
    expect(a.title).toBe('Outbound connection to known C2 | beacon pattern');
    expect(a.category).toBe('command_and_control');
    expect(a.occurredAt).toBe('2026-10-28T09:45:30.250Z');
    expect(a.description).toBe('Periodic beacon every 60s\nconfidence=high');
    expect(a.host).toEqual({ hostname: 'dev-ws-17' });
  });

  it('falls back to receivedAt when the event has no rt/start/end', () => {
    expect(okValue(lowRisk, '2026-10-28T12:00:00.000Z').occurredAt).toBe(
      '2026-10-28T12:00:00.000Z',
    );
    const r = normalizeCef(lowRisk);
    expect(!r.ok && r.error.code).toBe('missing_field');
  });

  it('rejects non-string input and empty names', () => {
    expect(normalizeCef({ line: 'x' }).ok).toBe(false);
    const r = normalizeCef('CEF:0|V|P|1|sig||3|rt=1793179860000');
    expect(!r.ok && r.error.code).toBe('missing_field');
    const r2 = normalizeCef('CEF:0||P|1|sig|Name|3|rt=1793179860000');
    expect(!r2.ok && r2.error.code).toBe('missing_field');
  });

  it.each([
    ['0', 'low'],
    ['3', 'low'],
    ['4', 'medium'],
    ['6', 'medium'],
    ['7', 'high'],
    ['8', 'high'],
    ['9', 'critical'],
    ['10', 'critical'],
    ['11', 'medium'],
    ['Very-High', 'critical'],
    ['Low', 'low'],
    ['Unknown', 'medium'],
  ])('maps CEF severity %s → %s', (input, expected) => {
    expect(cefSeverity(input)).toBe(expected);
  });
});
