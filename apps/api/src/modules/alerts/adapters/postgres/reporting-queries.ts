import type { Severity } from '@spine/shared-schema';
import { sql } from 'kysely';
import type { DbExecutor as Db } from '../../../../platform/events/types.js';
import type { AlertStatsRow } from '../../public-api.js';

/**
 * Reporting read model for the Metrics module (ADR-0026, ADR-0029, ADR-0095): MTTD, MTTR and
 * volume aggregates over the alerts received in `[from, to)`, computed **in Postgres**.
 *
 * Loading the rows and aggregating in Node cost memory proportional to the alert volume (the
 * soak test saw ~100 MB of transient heap per refresh at 177 k alerts/day). Aggregates cost the
 * same few bytes whatever the volume. The formulas mirror the Metrics module's TypeScript
 * definitions exactly, and a differential property test (`metrics-sql.test.ts`) keeps them equal:
 *
 * - time to detect = received − occurred, clamped at 0; negatives are counted as clock skew;
 * - time to resolve = resolved − received, clamped at 0, over **closed** alerts only (a reopened
 *   alert keeps its first close time, ADR-0036, but counts as open);
 * - percentiles are nearest-rank, which is exactly Postgres' `percentile_disc`;
 * - durations are numeric seconds, rounded to milliseconds.
 */
export async function alertStatsReceivedBetween(
  db: Db,
  from: Date,
  to: Date,
): Promise<AlertStatsRow> {
  const inWindow = sql`received_at >= ${from} and received_at < ${to}`;
  const ttd = sql`greatest(0, extract(epoch from received_at - occurred_at))`;
  const closedAt = sql`case when status in ('resolved', 'false_positive') then resolved_at end`;
  const ttr = sql`case when ${closedAt} is not null
                       then greatest(0, extract(epoch from ${closedAt} - received_at)) end`;

  const [totals, bySeverity, byDay] = await Promise.all([
    sql<{
      total: number;
      clock_skew: number;
      ttd_mean: string | null;
      ttd_p50: string | null;
      ttd_p90: string | null;
      closed: number;
      ttr_mean: string | null;
      ttr_p50: string | null;
      ttr_p90: string | null;
    }>`
      select count(*)::int                                                  as total,
             (count(*) filter (where received_at < occurred_at))::int        as clock_skew,
             round(avg(${ttd}), 3)                                           as ttd_mean,
             round(percentile_disc(0.5) within group (order by ${ttd}), 3)   as ttd_p50,
             round(percentile_disc(0.9) within group (order by ${ttd}), 3)   as ttd_p90,
             count(${ttr})::int                                              as closed,
             round(avg(${ttr}), 3)                                           as ttr_mean,
             round(percentile_disc(0.5) within group (order by ${ttr}), 3)   as ttr_p50,
             round(percentile_disc(0.9) within group (order by ${ttr}), 3)   as ttr_p90
        from alerts
       where ${inWindow}`.execute(db),
    sql<{ severity: Severity; count: number }>`
      select coalesce(severity, source_severity) as severity, count(*)::int as count
        from alerts
       where ${inWindow}
       group by 1`.execute(db),
    sql<{ day: string; count: number }>`
      select to_char(received_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as count
        from alerts
       where ${inWindow}
       group by 1
       order by 1`.execute(db),
  ]);

  const t = totals.rows[0];
  if (!t) throw new Error('aggregate query returned no row');
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    total: t.total,
    bySeverity: bySeverity.rows,
    byDay: byDay.rows,
    mttd: {
      count: t.total,
      meanSeconds: num(t.ttd_mean),
      p50Seconds: num(t.ttd_p50),
      p90Seconds: num(t.ttd_p90),
      clockSkewCount: t.clock_skew,
    },
    mttr: {
      count: t.closed,
      meanSeconds: num(t.ttr_mean),
      p50Seconds: num(t.ttr_p50),
      p90Seconds: num(t.ttr_p90),
      openCount: t.total - t.closed,
    },
  };
}
