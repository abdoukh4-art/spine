import { sql } from 'kysely';
import type { Db } from '../../../../platform/db/database.js';
import type { RunStatsRow } from '../../public-api.js';

/**
 * Reporting read model for the Metrics module (ADR-0026, ADR-0029, ADR-0095): playbook run
 * counts and durations, aggregated **in Postgres** so memory doesn't grow with run volume.
 * Mirrors the Metrics module's `computePlaybookStats` (kept equal by a differential test):
 *
 * - dry runs never count;
 * - counts per terminal status are over runs that finished in `[from, to)`; `inFlight` counts
 *   every unfinished run, whatever its age;
 * - latency = finished − started − approval wait, clamped at 0, over succeeded/failed/compensated
 *   runs with both timestamps; approval wait is reported over those runs that waited;
 * - percentiles are nearest-rank (`percentile_disc`), seconds rounded to milliseconds.
 */
export async function runStatsBetween(db: Db, from: Date, to: Date): Promise<RunStatsRow> {
  const finished = sql`status in ('succeeded', 'failed', 'compensated')
                       and started_at is not null and finished_at is not null`;
  const latency = sql`case when ${finished} then greatest(0,
                        extract(epoch from finished_at - started_at) - approval_wait_ms / 1000.0) end`;
  const wait = sql`case when ${finished} and approval_wait_ms > 0
                     then approval_wait_ms / 1000.0 end`;
  const { rows } = await sql<{
    succeeded: number;
    failed: number;
    compensated: number;
    cancelled: number;
    in_flight: number;
    lat_n: number;
    lat_mean: string | null;
    lat_p50: string | null;
    lat_p90: string | null;
    wait_n: number;
    wait_mean: string | null;
    wait_p50: string | null;
    wait_p90: string | null;
  }>`
    with runs as (
      select * from playbook_runs
       where not dry_run
         and ((finished_at >= ${from} and finished_at < ${to})
              or status in ('pending', 'running', 'waiting_approval', 'compensating'))
    )
    select (count(*) filter (where status = 'succeeded'))::int                   as succeeded,
           (count(*) filter (where status = 'failed'))::int                      as failed,
           (count(*) filter (where status = 'compensated'))::int                 as compensated,
           (count(*) filter (where status = 'cancelled'))::int                   as cancelled,
           (count(*) filter (where status in ('pending', 'running', 'waiting_approval', 'compensating')))::int
                                                                                 as in_flight,
           count(${latency})::int                                                as lat_n,
           round(avg(${latency}), 3)                                             as lat_mean,
           round(percentile_disc(0.5) within group (order by ${latency}), 3)     as lat_p50,
           round(percentile_disc(0.9) within group (order by ${latency}), 3)     as lat_p90,
           count(${wait})::int                                                   as wait_n,
           round(avg(${wait}), 3)                                                as wait_mean,
           round(percentile_disc(0.5) within group (order by ${wait}), 3)        as wait_p50,
           round(percentile_disc(0.9) within group (order by ${wait}), 3)        as wait_p90
      from runs`.execute(db);
  const r = rows[0];
  if (!r) throw new Error('aggregate query returned no row');
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    succeeded: r.succeeded,
    failed: r.failed,
    compensated: r.compensated,
    cancelled: r.cancelled,
    inFlight: r.in_flight,
    latency: {
      count: r.lat_n,
      meanSeconds: num(r.lat_mean),
      p50Seconds: num(r.lat_p50),
      p90Seconds: num(r.lat_p90),
    },
    approvalWait: {
      count: r.wait_n,
      meanSeconds: num(r.wait_mean),
      p50Seconds: num(r.wait_p50),
      p90Seconds: num(r.wait_p90),
    },
  };
}
