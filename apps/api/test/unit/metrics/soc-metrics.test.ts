import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildMetricsSummary,
  computeAlertVolume,
  computeMttd,
  computeMttr,
  computePlaybookStats,
  type AlertTimes,
  type RunTimes,
} from '../../../src/modules/metrics/domain/soc-metrics.js';
import {
  durationStat,
  percentileNearestRank,
} from '../../../src/modules/metrics/domain/statistics.js';

const t = (iso: string) => new Date(iso);

/**
 * Fixed fixture with hand-computed expectations (ADR-0026). Times are minutes after 10:00.
 *   alert  occurred  received  resolved   TTD(s)  TTR(s)
 *   A      10:00     10:05     10:35      300     1800
 *   B      10:00     10:01     10:11       60      600
 *   C      10:10     10:40     —         1800     open
 *   D      10:50     10:45     10:55        0*     600   (*clock skew: received before occurred)
 */
const fixture: AlertTimes[] = [
  {
    occurredAt: t('2026-10-28T10:00:00Z'),
    receivedAt: t('2026-10-28T10:05:00Z'),
    resolvedAt: t('2026-10-28T10:35:00Z'),
    severity: 'high',
  },
  {
    occurredAt: t('2026-10-28T10:00:00Z'),
    receivedAt: t('2026-10-28T10:01:00Z'),
    resolvedAt: t('2026-10-28T10:11:00Z'),
    severity: 'critical',
  },
  {
    occurredAt: t('2026-10-28T10:10:00Z'),
    receivedAt: t('2026-10-28T10:40:00Z'),
    resolvedAt: null,
    severity: 'low',
  },
  {
    occurredAt: t('2026-10-28T10:50:00Z'),
    receivedAt: t('2026-10-28T10:45:00Z'),
    resolvedAt: t('2026-10-28T10:55:00Z'),
    severity: 'high',
  },
];

describe('percentileNearestRank', () => {
  it('uses rank = ceil(p/100 * n)', () => {
    expect(percentileNearestRank([1, 2, 3, 4], 50)).toBe(2);
    expect(percentileNearestRank([1, 2, 3, 4], 90)).toBe(4);
    expect(percentileNearestRank([7], 50)).toBe(7);
    expect(percentileNearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });
  it('rejects empty input and out-of-range percentiles', () => {
    expect(() => percentileNearestRank([], 50)).toThrow(RangeError);
    expect(() => percentileNearestRank([1], 0)).toThrow(RangeError);
    expect(() => percentileNearestRank([1], 101)).toThrow(RangeError);
  });
});

describe('durationStat', () => {
  it('returns nulls for no samples', () => {
    expect(durationStat([])).toEqual({
      count: 0,
      meanSeconds: null,
      p50Seconds: null,
      p90Seconds: null,
    });
  });
});

describe('MTTD (ADR-0026)', () => {
  it('computes exact values on the fixture and counts clock skew', () => {
    // TTDs: 300, 60, 1800, 0 → mean 540; sorted [0,60,300,1800] → p50 = 60, p90 = 1800
    expect(computeMttd(fixture)).toEqual({
      count: 4,
      meanSeconds: 540,
      p50Seconds: 60,
      p90Seconds: 1800,
      clockSkewCount: 1,
    });
  });
});

describe('MTTR (ADR-0026)', () => {
  it('uses closed alerts only and reports open ones', () => {
    // TTRs: 1800, 600, 600 → mean 1000; sorted [600,600,1800] → p50 = 600, p90 = 1800
    expect(computeMttr(fixture)).toEqual({
      count: 3,
      meanSeconds: 1000,
      p50Seconds: 600,
      p90Seconds: 1800,
      openCount: 1,
    });
  });
});

describe('alert volume', () => {
  it('zero-fills severities and days in the window', () => {
    const v = computeAlertVolume(fixture, {
      from: t('2026-10-27T00:00:00Z'),
      to: t('2026-10-29T00:00:00Z'),
    });
    expect(v.total).toBe(4);
    expect(v.bySeverity).toEqual({ informational: 0, low: 1, medium: 0, high: 2, critical: 1 });
    expect(v.byDay).toEqual([
      { day: '2026-10-27', count: 0 },
      { day: '2026-10-28', count: 4 },
    ]);
  });
});

describe('playbook stats (ADR-0026)', () => {
  const base = { dryRun: false, approvalWaitMs: 0 };
  const runs: RunTimes[] = [
    {
      ...base,
      status: 'succeeded',
      startedAt: t('2026-10-28T10:00:00Z'),
      finishedAt: t('2026-10-28T10:00:10Z'),
    },
    // 70 s total, of which 60 s waiting for approval → 10 s of latency
    {
      ...base,
      status: 'succeeded',
      startedAt: t('2026-10-28T10:00:00Z'),
      finishedAt: t('2026-10-28T10:01:10Z'),
      approvalWaitMs: 60_000,
    },
    {
      ...base,
      status: 'failed',
      startedAt: t('2026-10-28T10:00:00Z'),
      finishedAt: t('2026-10-28T10:00:30Z'),
    },
    {
      ...base,
      status: 'compensated',
      startedAt: t('2026-10-28T10:00:00Z'),
      finishedAt: t('2026-10-28T10:00:20Z'),
    },
    {
      ...base,
      status: 'cancelled',
      startedAt: t('2026-10-28T10:00:00Z'),
      finishedAt: t('2026-10-28T10:00:05Z'),
    },
    { ...base, status: 'waiting_approval', startedAt: t('2026-10-28T10:00:00Z'), finishedAt: null },
    {
      ...base,
      status: 'succeeded',
      dryRun: true,
      startedAt: t('2026-10-28T10:00:00Z'),
      finishedAt: t('2026-10-28T10:00:01Z'),
    },
  ];

  it('excludes dry runs and cancelled runs from the success rate', () => {
    const stats = computePlaybookStats(runs);
    expect(stats.successRate).toBe(0.5); // 2 / (2 + 1 + 1)
    expect(stats.runs).toEqual({
      succeeded: 2,
      failed: 1,
      compensated: 1,
      cancelled: 1,
      inFlight: 1,
    });
  });

  it('excludes approval waiting time from latency and reports it separately', () => {
    const stats = computePlaybookStats(runs);
    // latencies: 10, 10, 30, 20 → mean 17.5; sorted [10,10,20,30] → p50 10, p90 30
    expect(stats.latency).toEqual({ count: 4, meanSeconds: 17.5, p50Seconds: 10, p90Seconds: 30 });
    expect(stats.approvalWait).toEqual({
      count: 1,
      meanSeconds: 60,
      p50Seconds: 60,
      p90Seconds: 60,
    });
  });

  it('returns a null success rate when nothing finished', () => {
    expect(computePlaybookStats([]).successRate).toBeNull();
  });
});

describe('buildMetricsSummary', () => {
  it('assembles all sections with ISO window bounds', () => {
    const s = buildMetricsSummary(
      { from: t('2026-10-28T00:00:00Z'), to: t('2026-10-29T00:00:00Z') },
      fixture,
      [],
    );
    expect(s.window).toEqual({ from: '2026-10-28T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' });
    expect(s.mttd.count).toBe(4);
    expect(s.playbooks.successRate).toBeNull();
  });
});

describe('statistics laws (property-based)', () => {
  const samples = fc.array(fc.double({ min: 0, max: 1e6, noNaN: true }), {
    minLength: 1,
    maxLength: 200,
  });
  it('min ≤ p50 ≤ p90 ≤ max and min ≤ mean ≤ max', () => {
    fc.assert(
      fc.property(samples, (xs) => {
        const s = durationStat(xs);
        const min = Math.min(...xs);
        const max = Math.max(...xs);
        const eps = 1e-3;
        return (
          s.count === xs.length &&
          s.p50Seconds! >= min - eps &&
          s.p50Seconds! <= s.p90Seconds! + eps &&
          s.p90Seconds! <= max + eps &&
          s.meanSeconds! >= min - eps &&
          s.meanSeconds! <= max + eps
        );
      }),
    );
  });
  it('percentiles are always observed values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1 }),
        fc.integer({ min: 1, max: 100 }),
        (xs, p) => {
          const sorted = [...xs].sort((a, b) => a - b);
          return xs.includes(percentileNearestRank(sorted, p));
        },
      ),
    );
  });
  it('MTTD is never negative and openCount + count = alerts for MTTR', () => {
    const alert = fc.record({
      occurredAt: fc.date({
        min: t('2026-01-01T00:00:00Z'),
        max: t('2026-12-31T00:00:00Z'),
        noInvalidDate: true,
      }),
      receivedAt: fc.date({
        min: t('2026-01-01T00:00:00Z'),
        max: t('2026-12-31T00:00:00Z'),
        noInvalidDate: true,
      }),
      resolvedAt: fc.option(
        fc.date({
          min: t('2026-01-01T00:00:00Z'),
          max: t('2027-06-30T00:00:00Z'),
          noInvalidDate: true,
        }),
        { nil: null },
      ),
      severity: fc.constantFrom('informational', 'low', 'medium', 'high', 'critical' as const),
    });
    fc.assert(
      fc.property(fc.array(alert, { maxLength: 50 }), (alerts) => {
        const mttd = computeMttd(alerts);
        const mttr = computeMttr(alerts);
        return (
          (mttd.meanSeconds ?? 0) >= 0 &&
          mttr.count + mttr.openCount === alerts.length &&
          (mttr.meanSeconds ?? 0) >= 0
        );
      }),
    );
  });
});
