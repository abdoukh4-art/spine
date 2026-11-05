import {
  CLOSED_ALERT_STATUSES,
  SEVERITIES,
  TERMINAL_RUN_STATUSES,
  type DurationStat,
  type MetricsSummary,
  type Severity,
} from '@spine/shared-schema';
import type { FakeDb } from './fixtures';

/** Nearest-rank percentile of an ascending-sorted list. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

/** count/mean/p50/p90 over durations in seconds (ADR-0026: null when empty). */
export function durationStat(values: readonly number[]): DurationStat {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    meanSeconds: sorted.length === 0 ? null : sorted.reduce((s, v) => s + v, 0) / sorted.length,
    p50Seconds: percentile(sorted, 50),
    p90Seconds: percentile(sorted, 90),
  };
}

const seconds = (fromIso: string, toIso: string) =>
  (Date.parse(toIso) - Date.parse(fromIso)) / 1000;

/** Computes `GET /metrics/summary` from the fake database (same definitions as ADR-0026). */
export function computeMetrics(db: FakeDb, from: number, to: number): MetricsSummary {
  const inWindow = db.alerts.filter((a) => {
    const t = Date.parse(a.alert.receivedAt);
    return t >= from && t <= to;
  });
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byDayMap = new Map<string, number>();
  for (let t = from; t <= to; t += 86_400_000)
    byDayMap.set(new Date(t).toISOString().slice(0, 10), 0);
  const lastDay = new Date(to).toISOString().slice(0, 10);
  if (!byDayMap.has(lastDay)) byDayMap.set(lastDay, 0);
  for (const a of inWindow) {
    const severity = a.severity ?? a.alert.severity;
    bySeverity[severity] += 1;
    const day = a.alert.receivedAt.slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + 1);
  }
  const detect = inWindow.map((a) => seconds(a.alert.occurredAt, a.alert.receivedAt));
  const respond = inWindow
    .filter((a) => a.resolvedAt !== null)
    .map((a) => seconds(a.alert.receivedAt, a.resolvedAt ?? ''));
  // ADR-0026: dry runs are excluded from playbook metrics.
  const runs = db.runs
    .map((r) => r.run)
    .filter((r) => {
      if (r.dryRun) return false;
      const t = Date.parse(r.createdAt);
      return t >= from && t <= to;
    });
  const count = (status: string) => runs.filter((r) => r.status === status).length;
  const finished = runs.filter(
    (r) => TERMINAL_RUN_STATUSES.includes(r.status) && r.status !== 'cancelled',
  );
  const latency = finished
    .filter((r) => r.startedAt && r.finishedAt)
    .map((r) => seconds(r.startedAt ?? '', r.finishedAt ?? ''));
  const waits = db.approvals
    .filter((a) => a.decidedAt)
    .map((a) => seconds(a.requestedAt, a.decidedAt ?? ''));
  return {
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    alertVolume: {
      total: inWindow.length,
      bySeverity,
      byDay: [...byDayMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, n]) => ({ day, count: n })),
    },
    mttd: { ...durationStat(detect), clockSkewCount: 0 },
    mttr: {
      ...durationStat(respond),
      openCount: inWindow.filter((a) => !CLOSED_ALERT_STATUSES.includes(a.alert.status)).length,
    },
    playbooks: {
      successRate: finished.length === 0 ? null : count('succeeded') / finished.length,
      runs: {
        succeeded: count('succeeded'),
        failed: count('failed'),
        compensated: count('compensated'),
        cancelled: count('cancelled'),
        inFlight: runs.length - finished.length - count('cancelled'),
      },
      latency: durationStat(latency),
      approvalWait: durationStat(waits),
    },
  };
}
