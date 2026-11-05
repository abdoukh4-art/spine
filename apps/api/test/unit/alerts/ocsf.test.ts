import {
  ALERT_STATUSES,
  INDICATOR_TYPES,
  OcsfDetectionFindingSchema,
  SEVERITIES,
  type AlertDetail,
} from '@spine/shared-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OCSF_VERSION, toOcsfDetectionFinding } from '../../../src/modules/alerts/domain/ocsf.js';
import { loadOcsfContract, validateOcsf } from '../../support/ocsf-validator.js';

const contract = loadOcsfContract('detection_finding-1.9.0.contract.json');
const ALERT_ID = '0190f0a0-0000-7000-8000-0000000000a1';

type AlertOverrides = { [K in keyof AlertDetail['alert']]?: AlertDetail['alert'][K] | undefined };

/** A realistic alert detail; an `alert` override set to `undefined` removes that field. */
function detail(
  overrides: { alert?: AlertOverrides } & Omit<Partial<AlertDetail>, 'alert'> = {},
): AlertDetail {
  const { alert: alertOverrides, ...rest } = overrides;
  const alert: AlertDetail['alert'] = {
    id: ALERT_ID,
    fingerprint: 'f'.repeat(64),
    status: 'new',
    receivedAt: '2026-10-29T10:00:05.000Z',
    lastSeenAt: '2026-10-29T10:03:00.000Z',
    duplicateCount: 2,
    source: { vendor: 'Fabrikam', product: 'EDR', sourceAlertId: 'EDR-1' },
    title: 'Cobalt Strike beacon and LSASS memory access on fin-db01',
    description: 'Beacon to 203.0.113.66',
    category: 'malware',
    severity: 'high',
    occurredAt: '2026-10-29T10:00:00.000Z',
    host: { hostname: 'fin-db01.corp.example', ips: ['10.20.5.20'] },
    indicators: [
      { type: 'ipv4', value: '203.0.113.66' },
      { type: 'sha256', value: 'a'.repeat(64) },
      { type: 'domain', value: 'login-micros0ft.example' },
    ],
    mitre: [
      {
        tacticId: 'TA0006',
        tacticName: 'Credential Access',
        techniqueId: 'T1003.001',
        techniqueName: 'LSASS Memory',
      },
      { techniqueId: 'T1071.001' },
    ],
    labels: {},
    raw: { secret: 'RAW-PAYLOAD' },
  };
  for (const [key, value] of Object.entries(alertOverrides ?? {})) {
    if (value === undefined) Reflect.deleteProperty(alert, key);
    else (alert as Record<string, unknown>)[key] = value;
  }
  return {
    summary: {
      id: ALERT_ID,
      title: alert.title,
      category: alert.category,
      status: alert.status,
      sourceSeverity: 'high',
      severity: 'critical',
      score: 100,
      source: { vendor: 'Fabrikam', product: 'EDR' },
      occurredAt: alert.occurredAt,
      receivedAt: alert.receivedAt,
      lastSeenAt: alert.lastSeenAt,
      duplicateCount: alert.duplicateCount,
      assigneeId: null,
      caseId: null,
      mitre: alert.mitre,
      resolvedAt: null,
    },
    alert,
    enrichments: [],
    score: {
      score: 100,
      rawScore: 120,
      severity: 'critical',
      rulesetVersion: 1,
      factors: [{ ruleId: 'baseline', description: 'Baseline', points: 40 }],
      dataGaps: [],
      computedAt: '2026-10-29T10:00:07.000Z',
    },
    runs: [],
    ...rest,
  };
}

const product = { version: '0.1.0' };

describe('OCSF export: conformance to OCSF 1.9.0 Detection Finding', () => {
  it('the contract is the one we think it is', () => {
    expect(contract.ocsfVersion).toBe(OCSF_VERSION);
    expect(contract.class).toMatchObject({
      name: 'detection_finding',
      category_uid: 2,
      class_uid: 2004,
    });
  });

  it('a realistic alert maps to a valid Detection Finding', () => {
    const finding = toOcsfDetectionFinding(detail(), product);
    expect(validateOcsf(finding, contract)).toEqual([]);
    expect(OcsfDetectionFindingSchema.safeParse(finding).success).toBe(true);
  });

  it('every alert Spine can hold maps to a valid Detection Finding (property)', () => {
    const indicator = fc.record({
      type: fc.constantFrom(...INDICATOR_TYPES),
      value: fc.string({ minLength: 1, maxLength: 40 }),
    });
    fc.assert(
      fc.property(
        fc.record({
          status: fc.constantFrom(...ALERT_STATUSES),
          severity: fc.option(fc.constantFrom(...SEVERITIES), { nil: null }),
          sourceSeverity: fc.constantFrom(...SEVERITIES),
          scored: fc.boolean(),
          host: fc.option(
            fc.record({
              hostname: fc.option(fc.domain(), { nil: undefined }),
              ips: fc.option(fc.array(fc.ipV4(), { maxLength: 3 }), { nil: undefined }),
            }),
            { nil: undefined },
          ),
          indicators: fc.array(indicator, { maxLength: 5 }),
          withTactic: fc.boolean(),
          description: fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
          sourceAlertId: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        }),
        (g) => {
          const base = detail();
          const d = detail({
            alert: {
              status: g.status,
              indicators: g.indicators,
              mitre: g.withTactic
                ? [{ tacticId: 'TA0002', techniqueId: 'T1059' }]
                : [{ techniqueId: 'T1059' }],
              source: {
                vendor: 'V',
                product: 'P',
                ...(g.sourceAlertId ? { sourceAlertId: g.sourceAlertId } : {}),
              },
              ...(g.description === undefined
                ? { description: undefined }
                : { description: g.description }),
              host: g.host
                ? {
                    ...(g.host.hostname ? { hostname: g.host.hostname } : {}),
                    ...(g.host.ips ? { ips: g.host.ips } : {}),
                  }
                : undefined,
            },
            summary: {
              ...base.summary,
              status: g.status,
              severity: g.severity,
              sourceSeverity: g.sourceSeverity,
            },
            score: g.scored ? base.score : null,
          });
          const finding = toOcsfDetectionFinding(d, product);
          const errors = validateOcsf(finding, contract);
          expect(errors).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the validator is not vacuous: it reports real violations', () => {
    const finding = toOcsfDetectionFinding(detail(), product) as unknown as Record<string, unknown>;
    const broken = {
      ...finding,
      severity_id: 7,
      time: '2026-10-29',
      finding_info: { title: 'no uid' },
      made_up: true,
    };
    const errors = validateOcsf(broken, contract);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^severity_id: 7 is not one of/),
        expect.stringMatching(/^time: expected long_t/),
        'finding_info.uid: required attribute missing',
        'made_up: not an attribute of this OCSF object',
      ]),
    );
  });
});

describe('OCSF export: mapping decisions (ADR-0097)', () => {
  it('identifies the class, activity and Spine as the product', () => {
    const f = toOcsfDetectionFinding(detail(), product);
    expect(f).toMatchObject({
      class_uid: 2004,
      category_uid: 2,
      activity_id: 1,
      type_uid: 200401,
      is_alert: true,
      metadata: { version: '1.9.0', uid: ALERT_ID, product: { name: 'Spine', version: '0.1.0' } },
      finding_info: {
        uid: ALERT_ID,
        uid_alt: 'EDR-1',
        types: ['malware'],
        product: { name: 'EDR', vendor_name: 'Fabrikam' },
      },
    });
  });

  it('uses receipt time for `time` and the sensor time for `start_time`, in epoch ms', () => {
    const f = toOcsfDetectionFinding(detail(), product);
    expect(f.time).toBe(Date.parse('2026-10-29T10:00:05.000Z'));
    expect(f.start_time).toBe(Date.parse('2026-10-29T10:00:00.000Z'));
  });

  it('maps severities, risk and statuses', () => {
    const f = toOcsfDetectionFinding(detail(), product);
    expect(f).toMatchObject({
      severity_id: 5,
      severity: 'Critical',
      risk_score: 100,
      risk_level_id: 4,
    });
    const fp = toOcsfDetectionFinding(detail({ alert: { status: 'false_positive' } }), product);
    expect(fp).toMatchObject({ status_id: 3, status: 'Suppressed' });
    const resolved = toOcsfDetectionFinding(detail({ alert: { status: 'resolved' } }), product);
    expect(resolved).toMatchObject({ status_id: 4, status: 'Resolved' });
    const unscored = toOcsfDetectionFinding(
      detail({
        score: null,
        summary: { ...detail().summary, severity: null, sourceSeverity: 'low' },
      }),
      product,
    );
    expect(unscored).toMatchObject({ severity_id: 2 });
    expect(unscored).not.toHaveProperty('risk_score');
  });

  it('maps ATT&CK, observables and the device; keeps the explanation under unmapped; drops raw', () => {
    const f = toOcsfDetectionFinding(detail(), product);
    expect(f.finding_info).toMatchObject({
      attacks: [
        {
          tactic: { uid: 'TA0006', name: 'Credential Access' },
          technique: { uid: 'T1003.001', name: 'LSASS Memory' },
        },
        { technique: { uid: 'T1071.001' } },
      ],
    });
    expect(f.observables).toEqual([
      { name: 'indicator.ipv4', type_id: 2, value: '203.0.113.66' },
      { name: 'indicator.sha256', type_id: 8, value: 'a'.repeat(64) },
      { name: 'indicator.domain', type_id: 1, value: 'login-micros0ft.example' },
      { name: 'device.hostname', type_id: 1, value: 'fin-db01.corp.example' },
      { name: 'device.ip', type_id: 2, value: '10.20.5.20' },
    ]);
    expect(f.device).toEqual({ type_id: 0, hostname: 'fin-db01.corp.example', ip: '10.20.5.20' });
    expect(f.unmapped.spine).toMatchObject({
      duplicates: 2,
      score: { score: 100, rulesetVersion: 1 },
    });
    expect(JSON.stringify(f)).not.toContain('RAW-PAYLOAD');
  });
});
