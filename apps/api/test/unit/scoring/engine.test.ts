import {
  ScoreExplanationSchema,
  severityFromScore,
  type Condition,
  type EnrichmentResult,
  type Ruleset,
  type ScoringRule,
} from '@spine/shared-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  score,
  evidenceFor,
  BASELINE_RULE_ID,
} from '../../../src/modules/scoring/domain/engine.js';
import { buildEvaluationContext } from '../../../src/modules/scoring/domain/evaluation-context.js';
import { results, smallRuleset, testAlert } from './fixtures.js';

const now = new Date('2026-10-28T10:00:02.000Z');

describe('scoring engine', () => {
  it('adds the baseline and every matching rule, with evidence', () => {
    const explanation = score(
      testAlert(),
      [results.malicious(), results.asset('critical')],
      smallRuleset,
      now,
    );
    expect(explanation).toEqual({
      score: 90,
      rawScore: 90,
      severity: 'critical',
      rulesetVersion: 7,
      factors: [
        {
          ruleId: 'baseline',
          description: 'Baseline for source severity "high"',
          points: 40,
          evidence: 'severity=high',
        },
        {
          ruleId: 'malicious-indicator',
          description: 'Malicious indicator',
          points: 30,
          evidence: '203.0.113.66',
        },
        {
          ruleId: 'critical-asset',
          description: 'Critical asset',
          points: 20,
          evidence: 'critical', // no evidenceField → value of the first field
        },
      ],
      dataGaps: [],
      computedAt: '2026-10-28T10:00:02.000Z',
    });
    expect(ScoreExplanationSchema.safeParse(explanation).success).toBe(true);
  });

  it('says explicitly when only the baseline applies', () => {
    const explanation = score(testAlert({ severity: 'low' }), [], smallRuleset, now);
    expect(explanation.factors).toHaveLength(1);
    expect(explanation.factors[0]?.description).toMatch(/no scoring rule matched/);
    expect(explanation).toMatchObject({ score: 10, severity: 'informational' });
  });

  it('clamps to [0, 100] while rawScore keeps the true sum', () => {
    const low = score(
      testAlert({ severity: 'informational' }),
      [results.malicious('192.0.2.1', ['authorized-scanner'])],
      smallRuleset,
      now,
    );
    expect(low.rawScore).toBe(0 + 30 - 60);
    expect(low.score).toBe(0);

    const generous: Ruleset = {
      ...smallRuleset,
      rules: [{ ...smallRuleset.rules[0]!, points: 100 }],
    };
    const high = score(testAlert({ severity: 'critical' }), [results.malicious()], generous, now);
    expect(high.rawScore).toBe(155);
    expect(high.score).toBe(100);
  });

  it('lists failed providers as data gaps; missing data never matches', () => {
    const explanation = score(
      testAlert(),
      [results.failed('asset-inventory', 'timeout'), results.failed('geo', 'circuit_open')],
      smallRuleset,
      now,
    );
    expect(explanation.dataGaps).toEqual(['asset-inventory', 'geo']);
    expect(explanation.factors.map((f) => f.ruleId)).toEqual([BASELINE_RULE_ID]);
  });

  it('truncates long evidence and omits missing evidence', () => {
    const many = Array.from({ length: 80 }, (_, i) => results.malicious(`203.0.113.${i}`));
    const context = buildEvaluationContext(testAlert(), many);
    const evidence = evidenceFor(context, 'enrichment.maliciousIndicators');
    expect(evidence).toHaveLength(500);
    expect(evidence?.endsWith('…')).toBe(true);
    expect(evidenceFor(context, 'enrichment.asset.hostname')).toBeUndefined();
    expect(evidenceFor(context, undefined)).toBeUndefined();
    expect(evidenceFor(context, 'enrichment.geo')).toBe(
      '{"countries":[],"asns":[],"isTor":false,"torIps":[]}',
    );
    expect(evidenceFor(context, 'enrichment.geo.isTor')).toBe('false');
  });
});

describe('evaluation context', () => {
  it('summarizes enrichment results into rule-friendly facts', () => {
    const context = buildEvaluationContext(testAlert(), [
      results.malicious('203.0.113.66', ['c2', 'cobalt-strike']),
      results.suspicious('198.51.100.77', ['tor-exit']),
      results.geo('198.51.100.77', 'DE', true),
      results.geo('203.0.113.66', 'NL', false),
      results.asset('high'),
      results.asset('critical', ['tier0']),
      results.asset('low'),
      results.failed('geo', 'timeout'),
      { ...results.failed('reputation', 'error'), status: 'not_found' },
    ]);
    expect(context.enrichment).toEqual({
      verdicts: ['malicious', 'suspicious'],
      maxReputationScore: 96,
      maliciousIndicators: ['203.0.113.66'],
      maliciousIndicatorTypes: ['ipv4'],
      suspiciousIndicators: ['198.51.100.77'],
      reputationTags: ['c2', 'cobalt-strike', 'tor-exit'],
      asset: {
        hostname: 'host-critical.corp.example',
        criticality: 'critical',
        owner: 'it@corp.example',
        businessUnit: null,
        tags: ['tier0'],
      },
      geo: { countries: ['DE', 'NL'], asns: [64500], isTor: true, torIps: ['198.51.100.77'] },
      failedProviders: ['geo'],
    });
  });

  it('falls back to the reputation data verdict and tolerates sparse geo data', () => {
    const { verdict: _v, ...noTopLevelVerdict } = results.malicious('203.0.113.7');
    const sparseGeo: EnrichmentResult = {
      ...results.geo('192.0.2.10', 'US', false),
      data: { kind: 'geo', isTor: false },
    };
    const context = buildEvaluationContext(testAlert(), [
      noTopLevelVerdict,
      sparseGeo,
      results.geo('198.51.100.1', 'FR', false),
      {
        ...results.geo('198.51.100.2', 'DE', false),
        data: { kind: 'geo', asn: 64496, isTor: false },
      },
    ]);
    expect(context.enrichment).toMatchObject({
      verdicts: ['malicious'],
      maliciousIndicators: ['203.0.113.7'],
      geo: { countries: ['FR'], asns: [64496, 64500], isTor: false, torIps: [] },
    });
  });

  it('is empty-but-well-formed without enrichment', () => {
    expect(buildEvaluationContext(testAlert(), []).enrichment).toMatchObject({
      verdicts: [],
      maxReputationScore: null,
      asset: null,
      geo: { isTor: false },
    });
  });
});

// ------------------------------------------------------------------ properties

const severityArb = fc.constantFrom('informational', 'low', 'medium', 'high', 'critical' as const);

const enrichmentArb: fc.Arbitrary<EnrichmentResult[]> = fc.array(
  fc.oneof(
    fc.constant(results.malicious()),
    fc.constant(results.suspicious()),
    fc.constant(results.malicious('192.0.2.50', ['authorized-scanner'])),
    fc.constantFrom('low', 'medium', 'high', 'critical' as const).map((c) => results.asset(c)),
    fc.boolean().map((tor) => results.geo('198.51.100.77', 'DE', tor)),
    fc
      .constantFrom('timeout', 'error', 'circuit_open', 'rejected' as const)
      .map((s) => results.failed('geo', s)),
  ),
  { maxLength: 6 },
);

const leafArb: fc.Arbitrary<Condition> = fc.oneof(
  fc
    .constantFrom('malicious', 'suspicious', 'benign')
    .map((v): Condition => ({ field: 'enrichment.verdicts', op: 'contains', value: v })),
  fc
    .constantFrom('low', 'high', 'critical')
    .map((v): Condition => ({ field: 'enrichment.asset.criticality', op: 'eq', value: v })),
  fc.constant<Condition>({ field: 'enrichment.geo.isTor', op: 'eq', value: true }),
  fc
    .integer({ min: 0, max: 20 })
    .map((n): Condition => ({ field: 'alert.duplicateCount', op: 'gte', value: n })),
  fc
    .constantFrom('TA0006', 'TA0008')
    .map((t): Condition => ({ field: 'alert.mitre.tacticId', op: 'contains', value: t })),
);
const conditionArb: fc.Arbitrary<Condition> = fc.oneof(
  { depthSize: 'small' },
  leafArb,
  fc.array(leafArb, { minLength: 1, maxLength: 3 }).map((all): Condition => ({ all })),
  fc.array(leafArb, { minLength: 1, maxLength: 3 }).map((any): Condition => ({ any })),
  leafArb.map((not): Condition => ({ not })),
);
const ruleArb = (i: number): fc.Arbitrary<ScoringRule> =>
  fc.record({
    id: fc.constant(`rule-${i}`),
    description: fc.constant(`Rule ${i}`),
    when: conditionArb,
    points: fc.integer({ min: -100, max: 100 }),
  });
const rulesetArb: fc.Arbitrary<Ruleset> = fc
  .integer({ min: 0, max: 12 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => ruleArb(i))))
  .chain((rules) =>
    fc.record({
      version: fc.integer({ min: 1, max: 9 }),
      baseline: fc.record({
        fromSeverity: fc.record({
          informational: fc.integer({ min: 0, max: 100 }),
          low: fc.integer({ min: 0, max: 100 }),
          medium: fc.integer({ min: 0, max: 100 }),
          high: fc.integer({ min: 0, max: 100 }),
          critical: fc.integer({ min: 0, max: 100 }),
        }),
      }),
      rules: fc.constant(rules),
    }),
  );
const alertArb = fc
  .record({
    severity: severityArb,
    duplicateCount: fc.integer({ min: 0, max: 30 }),
    tactics: fc.subarray(['TA0006', 'TA0008', 'TA0011']),
  })
  .map(({ severity, duplicateCount, tactics }) =>
    testAlert({
      severity,
      duplicateCount,
      mitre: tactics.map((tacticId) => ({ tacticId, techniqueId: 'T1078' })),
    }),
  );

describe('scoring engine properties (ADR-0015)', () => {
  it('score is always an integer in [0, 100] and severity follows the fixed bands', () => {
    fc.assert(
      fc.property(alertArb, enrichmentArb, rulesetArb, (alert, enrichments, ruleset) => {
        const e = score(alert, enrichments, ruleset, now);
        expect(Number.isInteger(e.score)).toBe(true);
        expect(e.score).toBeGreaterThanOrEqual(0);
        expect(e.score).toBeLessThanOrEqual(100);
        expect(e.severity).toBe(severityFromScore(e.score));
        expect(ScoreExplanationSchema.safeParse(e).success).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('rawScore is exactly the sum of the factor points, and there is always >= 1 factor', () => {
    fc.assert(
      fc.property(alertArb, enrichmentArb, rulesetArb, (alert, enrichments, ruleset) => {
        const e = score(alert, enrichments, ruleset, now);
        expect(e.factors.length).toBeGreaterThanOrEqual(1);
        expect(e.factors[0]?.ruleId).toBe(BASELINE_RULE_ID);
        expect(e.rawScore).toBe(e.factors.reduce((s, f) => s + f.points, 0));
        expect(e.score).toBe(Math.min(100, Math.max(0, e.rawScore)));
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic: same inputs, same explanation', () => {
    fc.assert(
      fc.property(alertArb, enrichmentArb, rulesetArb, (alert, enrichments, ruleset) => {
        expect(score(alert, enrichments, ruleset, now)).toEqual(
          score(
            structuredClone(alert),
            structuredClone(enrichments),
            structuredClone(ruleset),
            now,
          ),
        );
      }),
    );
  });

  it('adding a matching rule with positive points never lowers the score', () => {
    fc.assert(
      fc.property(
        alertArb,
        enrichmentArb,
        rulesetArb,
        conditionArb,
        fc.integer({ min: 1, max: 100 }),
        (alert, enrichments, ruleset, when, points) => {
          const before = score(alert, enrichments, ruleset, now);
          const extra: ScoringRule = { id: 'extra-rule', description: 'Extra', when, points };
          const after = score(
            alert,
            enrichments,
            { ...ruleset, rules: [...ruleset.rules, extra] },
            now,
          );
          expect(after.score).toBeGreaterThanOrEqual(before.score);
          const matched = after.factors.some((f) => f.ruleId === 'extra-rule');
          expect(after.rawScore).toBe(before.rawScore + (matched ? points : 0));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('removing all rules leaves only the baseline factor', () => {
    fc.assert(
      fc.property(alertArb, enrichmentArb, rulesetArb, (alert, enrichments, ruleset) => {
        const e = score(alert, enrichments, { ...ruleset, rules: [] }, now);
        expect(e.factors).toHaveLength(1);
        expect(e.factors[0]?.ruleId).toBe(BASELINE_RULE_ID);
        expect(e.rawScore).toBe(ruleset.baseline.fromSeverity[alert.severity]);
      }),
    );
  });

  it('dataGaps lists exactly the providers with a failed lookup', () => {
    fc.assert(
      fc.property(alertArb, enrichmentArb, rulesetArb, (alert, enrichments, ruleset) => {
        const failed = new Set(
          enrichments
            .filter((r) => ['timeout', 'error', 'circuit_open', 'rejected'].includes(r.status))
            .map((r) => r.provider),
        );
        expect(new Set(score(alert, enrichments, ruleset, now).dataGaps)).toEqual(failed);
      }),
    );
  });
});
