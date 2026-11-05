import { RAW_PAYLOAD_MAX_BYTES, type CanonicalAlert } from '@spine/shared-schema';
import { describe, expect, it } from 'vitest';
import { computeFingerprint } from './fingerprint.js';
import { capRawPayload, prepareAlert } from './prepare-alert.js';

const base: CanonicalAlert = {
  source: { vendor: 'Contoso Security', product: 'CloudAudit' },
  title: 'Impossible travel',
  category: 'credential_access',
  severity: 'medium',
  occurredAt: '2026-10-28T08:05:00.000Z',
  indicators: [{ type: 'ipv4', value: '192.0.2.201' }],
  mitre: [],
  labels: {},
};

describe('capRawPayload', () => {
  it('keeps a payload that fits and replaces one that does not', () => {
    expect(capRawPayload({ a: 1 })).toEqual({ a: 1 });
    const big = { blob: 'x'.repeat(RAW_PAYLOAD_MAX_BYTES) };
    expect(capRawPayload(big)).toEqual({
      truncated: true,
      bytes: JSON.stringify(big).length,
    });
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // 30 000 × 'é' = 30 000 JS chars but 60 000 bytes (+ quotes): over a 50 000-byte cap.
    const raw = 'é'.repeat(30_000);
    expect(capRawPayload(raw, 50_000)).toEqual({ truncated: true, bytes: 60_002 });
    expect(capRawPayload(raw, 70_000)).toBe(raw);
  });

  it('handles values JSON cannot serialize', () => {
    expect(capRawPayload(undefined)).toBeUndefined();
    expect(capRawPayload(() => 1)).toBeUndefined();
    expect(capRawPayload(10n)).toEqual({ truncated: true, bytes: -1 });
  });
});

describe('prepareAlert', () => {
  it('normalizes indicators, drops absent raw and fingerprints the normalized result', () => {
    const prepared = prepareAlert({
      ...base,
      user: { email: 'Frank@Corp.Example' },
      indicators: [
        { type: 'ipv4', value: '192[.]0[.]2[.]201' },
        { type: 'ipv4', value: '999.1.1.1' },
      ],
    });
    expect(prepared.alert.indicators).toEqual([
      { type: 'ipv4', value: '192.0.2.201' },
      { type: 'email', value: 'frank@corp.example' },
    ]);
    expect('raw' in prepared.alert).toBe(false);
    expect(prepared.fingerprint).toBe(
      computeFingerprint({ ...base, indicators: prepared.alert.indicators }),
    );
  });

  it('gives the same fingerprint to defanged and plain spellings of one alert', () => {
    const plain = prepareAlert(base);
    const defanged = prepareAlert({
      ...base,
      indicators: [{ type: 'ipv4', value: ' 192[.]0.2.201 ' }],
    });
    expect(defanged.fingerprint).toBe(plain.fingerprint);
  });

  it('caps an oversized raw payload', () => {
    const prepared = prepareAlert({ ...base, raw: { blob: 'y'.repeat(70_000) } });
    expect(prepared.alert.raw).toMatchObject({ truncated: true });
  });
});
