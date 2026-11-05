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
 * What the playbook metrics need from a set of runs (ADR-0095): counts per outcome and the two
 * duration distributions. Produced by the database in production (`runStatsBetween`) and by
 * {@link aggregateRuns} from rows, which is the executable specification of the formulas.
 */
export interface RunAggregates {
  succeeded: number;
  failed: number;
  compensated: number;
  cancelled: number;
  inFlight: number;
  latency: DurationStat;
  approvalWait: DurationStat;
}

/**
 * Aggregates runs: dry runs never count. Latency excludes approval waiting time (reported
 * separately) and is measured over finished runs (succeeded, failed, compensated) only.
 */
export function aggregateRuns(runs: readonly RunTimes[]): RunAggregates {
  const real = runs.filter((r) => !r.dryRun);
  const count = (status: RunStatus) => real.filter((r) => r.status === status).length;
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
    succeeded: count('succeeded'),
    failed: count('failed'),
    compensated: count('compensated'),
    cancelled: count('cancelled'),
    inFlight: real.filter((r) => IN_FLIGHT.includes(r.status)).length,
    latency: durationStat(latency),
    approvalWait: durationStat(approvalWaits),
  };
}

/**
 * Playbook success rate = succeeded / (succeeded + failed + compensated) over finished,
 * non-dry-run runs; cancelled runs are excluded (a human chose to stop them).
 */
export function playbookStatsFrom(agg: RunAggregates): MetricsSummary['playbooks'] {
  const denominator = agg.succeeded + agg.failed + agg.compensated;
  return {
    successRate:
      denominator === 0 ? null : Math.round((agg.succeeded / denominator) * 10_000) / 10_000,
    runs: {
      succeeded: agg.succeeded,
      failed: agg.failed,
      compensated: agg.compensated,
      cancelled: agg.cancelled,
      inFlight: agg.inFlight,
    },
    latency: agg.latency,
    approvalWait: agg.approvalWait,
  };
}

/** Playbook metrics straight from rows (the specification; see {@link aggregateRuns}). */
export function computePlaybookStats(runs: readonly RunTimes[]): MetricsSummary['playbooks'] {
  return playbookStatsFrom(aggregateRuns(runs));
}

/** UTC calendar day (YYYY-MM-DD) of a date. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * What the alert metrics need from the alerts received in a window (ADR-0095). Counts per
 * severity and per day are sparse. Produced by the database in production
 * (`statsReceivedBetween`) and by {@link aggregateAlerts} from rows (the specification).
 */
export interface AlertAggregates {
  total: number;
  bySeverity: { severity: Severity; count: number }[];
  byDay: { day: string; count: number }[];
  mttd: DurationStat & { clockSkewCount: number };
  mttr: DurationStat & { openCount: number };
}

/** Aggregates alert rows exactly as the database query must (the executable specification). */
export function aggregateAlerts(alerts: readonly AlertTimes[]): AlertAggregates {
  const bySeverity = new Map<Severity, number>();
  const byDay = new Map<string, number>();
  for (const a of alerts) {
    bySeverity.set(a.severity, (bySeverity.get(a.severity) ?? 0) + 1);
    const day = utcDay(a.receivedAt);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return {
    total: alerts.length,
    bySeverity: [...bySeverity.entries()].map(([severity, count]) => ({ severity, count })),
    byDay: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => ({ day, count })),
    mttd: computeMttd(alerts),
    mttr: computeMttr(alerts),
  };
}

/**
 * Alert volume in the window: total, per severity (every severity present, zero-filled)
 * and per UTC day (every day of the window present, zero-filled, so charts have no gaps).
 */
export function alertVolumeFrom(
  agg: AlertAggregates,
  window: TimeWindow,
): MetricsSummary['alertVolume'] {
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const { severity, count } of agg.bySeverity) bySeverity[severity] += count;
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
  for (const { day, count } of agg.byDay) byDayMap.set(day, (byDayMap.get(day) ?? 0) + count);
  return {
    total: agg.total,
    bySeverity,
    byDay: [...byDayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => ({ day, count })),
  };
}

/** Alert volume straight from rows (the specification; see {@link aggregateAlerts}). */
export function computeAlertVolume(
  alerts: readonly AlertTimes[],
  window: TimeWindow,
): MetricsSummary['alertVolume'] {
  return alertVolumeFrom(aggregateAlerts(alerts), window);
}

/** Assembles the full summary for a window from aggregates (what production uses). */
export function summaryFromAggregates(
  window: TimeWindow,
  alerts: AlertAggregates,
  runs: RunAggregates,
): MetricsSummary {
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    alertVolume: alertVolumeFrom(alerts, window),
    mttd: alerts.mttd,
    mttr: alerts.mttr,
    playbooks: playbookStatsFrom(runs),
  };
}

/** Assembles the full summary for a window from read-model rows (the specification). */
export function buildMetricsSummary(
  window: TimeWindow,
  alerts: readonly AlertTimes[],
  runs: readonly RunTimes[],
): MetricsSummary {
  return summaryFromAggregates(window, aggregateAlerts(alerts), aggregateRuns(runs));
}
