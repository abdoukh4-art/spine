import { describe, expect, it } from 'vitest';
import { suricataEveLines } from '../../fixtures/index.js';
import { normalizeSuricataEve } from './suricata-eve.js';

const [c2, flow, scan, phishing, dns, ipv6] = suricataEveLines() as [
  string,
  string,
  string,
  string,
  string,
  string,
];

function okValue(line: unknown) {
  const result = normalizeSuricataEve(line);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('suricata-eve normalizer', () => {
  it('maps a C2 alert: title, severity 1 → high, network, MITRE, TLS SNI', () => {
    const alert = okValue(c2);
    expect(alert.title).toBe('ET MALWARE Cobalt Strike Beacon Observed');
    expect(alert.severity).toBe('high');
    // 'beacon' matches the C2 rule before 'malware' matches: the first rule wins.
    expect(alert.category).toBe('command_and_control');
    expect(alert.occurredAt).toBe('2026-10-28T09:12:44.123Z');
    expect(alert.source).toEqual({
      vendor: 'OISF',
      product: 'Suricata',
      sourceAlertId: '1844674407370955161:2035465',
    });
    expect(alert.network).toEqual({
      sourceIp: '10.20.30.40',
      sourcePort: 49812,
      destinationIp: '203.0.113.66',
      destinationPort: 443,
      protocol: 'tcp',
    });
    expect(alert.mitre).toEqual([
      {
        tacticId: 'TA0011',
        tacticName: 'Command And Control',
        techniqueId: 'T1071.001',
        techniqueName: 'Web Protocols',
      },
    ]);
    expect(alert.indicators).toContainEqual({ type: 'domain', value: 'cdn-update.example.com' });
    expect(alert.labels['suricata.sensor']).toBe('sensor-dmz-01');
    expect(alert.labels['suricata.signature_id']).toBe('2035465');
  });

  it('keeps every digit of a 64-bit flow_id when given the raw line', () => {
    // JSON.parse would round 1844674407370955161 to 1844674407370955300.
    expect(okValue(c2).source.sourceAlertId).toBe('1844674407370955161:2035465');
    const parsed = JSON.parse(scan) as unknown;
    expect(okValue(parsed).source.sourceAlertId).toBe('912345678901234:2001219');
  });

  it('maps severity 2 → medium and 3 → low, and classifies categories from text', () => {
    const s = okValue(scan);
    expect(s.severity).toBe('medium');
    expect(s.category).toBe('reconnaissance');
    const p = okValue(phishing);
    expect(p.severity).toBe('low');
    expect(p.category).toBe('phishing');
    expect(p.url).toBe('http://login-portal.example.net/owa/auth.php?session=1');
    expect(p.labels['http.user_agent']).toContain('Mozilla');
  });

  it('canonicalizes IPv6 addresses and converts offsets to UTC', () => {
    const alert = okValue(ipv6);
    expect(alert.network?.sourceIp).toBe('2001:db8::42');
    expect(alert.occurredAt).toBe('2026-10-28T08:25:44.250Z');
    expect(alert.category).toBe('intrusion');
  });

  it('reports non-alert events as not_an_alert (they are skipped, not errors)', () => {
    for (const line of [flow, dns]) {
      const r = normalizeSuricataEve(line);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('not_an_alert');
    }
  });

  it.each([
    ['not json', '{oops', 'invalid_json'],
    ['an array', '[1,2]', 'parse_error'],
    ['no alert object', '{"event_type":"alert"}', 'missing_field'],
    [
      'no signature',
      '{"event_type":"alert","alert":{},"timestamp":"2026-10-28T09:00:00Z"}',
      'missing_field',
    ],
    [
      'a bad timestamp',
      '{"event_type":"alert","alert":{"signature":"x"},"timestamp":"yesterday"}',
      'missing_field',
    ],
  ])('rejects %s with a typed error, without throwing', (_name, input, code) => {
    const r = normalizeSuricataEve(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('drops invalid IPs and ports instead of failing the alert', () => {
    const alert = okValue({
      event_type: 'alert',
      timestamp: '2026-10-28T09:00:00Z',
      src_ip: 'not-an-ip',
      dest_ip: '192.0.2.1',
      dest_port: 70000,
      alert: { signature: 'GPL ATTACK_RESPONSE id check returned root', severity: 9 },
      dns: { query: [{ rrname: 'a.example' }] },
      fileinfo: { sha256: 'a'.repeat(64) },
    });
    expect(alert.network).toEqual({ destinationIp: '192.0.2.1' });
    expect(alert.severity).toBe('medium');
    expect(alert.source.sourceAlertId).toBeUndefined();
    expect(alert.indicators).toEqual(
      expect.arrayContaining([
        { type: 'domain', value: 'a.example' },
        { type: 'sha256', value: 'a'.repeat(64) },
      ]),
    );
  });
});
