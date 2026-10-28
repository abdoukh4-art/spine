import {
  SEVERITIES,
  type DurationStat,
  type MetricsSummary,
  type RunStatus,
  type Severity,
} from '@spine/shared-schema';
import { durationStat, secondsBetween } from './statistics.js';

/**
 * SOC metric formulas, exactly as defined in ADR-0026. Inputs are plain read-model rows
 * supplied by other modules' public APIs; outputs are the `MetricsSummary` pieces.
 */

/** The timestamps of one alert that MTTD/MTTR need. */
export interface AlertTimes {
  occurredAt: Date;
  receivedAt: Date;
  /** First transition to resolved/false_positive, or null while open. */
  resolvedAt: Date | null;
  /** Score-derived severity, falling back to the source severity before scoring. */
  severity: Severity;
}

/** The fields of one playbook run that success-rate and latency need. */
export interface RunTimes {
  status: RunStatus;
  dryRun: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Total time spent waiting for human approval, excluded from latency. */
  approvalWaitMs: number;
}

export interface TimeWindow {
  from: Date;
  to: Date;
}

/**
 * MTTD: mean of (receivedAt − occurredAt). Negative values (the source clock is ahead of
 * ours) are clamped to 0 and counted in `clockSkewCount`, so skew is visible instead of
 * silently lowering the mean.
 */
export function computeMttd(
  alerts: readonly AlertTimes[],
): DurationStat & { clockSkewCount: number } {
  let clockSkewCount = 0;
  const samples = alerts.map((a) => {
    const ttd = secondsBetween(a.occurredAt, a.receivedAt);
    if (ttd < 0) {
      clockSkewCount += 1;
      return 0;
    }
    return ttd;
  });
  return { ...durationStat(samples), clockSkewCount };
}

/**
 * MTTR: mean of (resolvedAt − receivedAt) over **closed** alerts only. `openCount` is
 * reported alongside, because excluding open alerts flatters MTTR while a backlog grows.
 */
export function computeMttr(alerts: readonly AlertTimes[]): DurationStat & { openCount: number } {
  const samples: number[] = [];
  let openCount = 0;
  for (const a of alerts) {
    if (a.resolvedAt === null) {
      openCount += 1;
    } else {
      samples.push(Math.max(0, secondsBetween(a.receivedAt, a.resolvedAt)));
    }
  }
  return { ...durationStat(samples), openCount };
}

const FINISHED_FOR_RATE: readonly RunStatus[] = ['succeeded', 'failed', 'compensated'];
const IN_FLIGHT: readonly RunStatus[] = ['pending', 'running', 'waiting_approval', 'compensating'];

/**
 * Playbook success rate = succeeded / (succeeded + failed + compensated) over finished,
 * non-dry-run runs; cancelled runs are excluded (a human chose to stop them). Latency
 * excludes approval waiting time, which is reported separately.
 */
export function computePlaybookStats(runs: readonly RunTimes[]): MetricsSummary['playbooks'] {
  const real = runs.filter((r) => !r.dryRun);
  const count = (status: RunStatus) => real.filter((r) => r.status === status).length;
  const succeeded = count('succeeded');
  const failed = count('failed');
  const compensated = count('compensated');
  const denominator = succeeded + failed + compensated;

  const finished = real.filter(
    (r) => FINISHED_FOR_RATE.includes(r.status) && r.startedAt !== null && r.finishedAt !== null,
  );
  const latency = finished.map((r) =>
    Math.max(
      0,
      secondsBetween(r.startedAt as Date, r.finishedAt as Date) - r.approvalWaitMs / 1000,
    ),
  );
  const approvalWaits = finished
    .filter((r) => r.approvalWaitMs > 0)
    .map((r) => r.approvalWaitMs / 1000);

  return {
    successRate: denominator === 0 ? null : Math.round((succeeded / denominator) * 10_000) / 10_000,
    runs: {
      succeeded,
      failed,
      compensated,
      cancelled: count('cancelled'),
      inFlight: real.filter((r) => IN_FLIGHT.includes(r.status)).length,
    },
    latency: durationStat(latency),
    approvalWait: durationStat(approvalWaits),
  };
}

/** UTC calendar day (YYYY-MM-DD) of a date. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Alert volume in the window: total, per severity (every severity present, zero-filled)
 * and per UTC day (every day of the window present, zero-filled, so charts have no gaps).
 */
export function computeAlertVolume(
  alerts: readonly AlertTimes[],
  window: TimeWindow,
): MetricsSummary['alertVolume'] {
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byDayMap = new Map<string, number>();
  for (
    let day = new Date(
      Date.UTC(window.from.getUTCFullYear(), window.from.getUTCMonth(), window.from.getUTCDate()),
    );
    day < window.to;
    day = new Date(day.getTime() + 86_400_000)
  ) {
    byDayMap.set(utcDay(day), 0);
  }
  for (const a of alerts) {
    bySeverity[a.severity] += 1;
    const key = utcDay(a.receivedAt);
    byDayMap.set(key, (byDayMap.get(key) ?? 0) + 1);
  }
  return {
    total: alerts.length,
    bySeverity,
    byDay: [...byDayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => ({ day, count })),
  };
}

/** Assembles the full summary for a window from read-model rows. */
export function buildMetricsSummary(
  window: TimeWindow,
  alerts: readonly AlertTimes[],
  runs: readonly RunTimes[],
): MetricsSummary {
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    alertVolume: computeAlertVolume(alerts, window),
    mttd: computeMttd(alerts),
    mttr: computeMttr(alerts),
    playbooks: computePlaybookStats(runs),
  };
}
