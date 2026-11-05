import type { DurationStat, RunSummary } from '@spine/shared-schema';

/** Public API of the Playbooks module. Other modules may import ONLY this file. */
export interface PlaybooksPublicApi {
  /** Runs started for an alert, newest first. */
  runsForAlert(alertId: string): Promise<RunSummary[]>;
  /**
   * Aggregates of the (non-dry-run) runs that finished in [from, to), plus the number of runs
   * still in flight, computed in the database for the Metrics module (ADR-0026, ADR-0095).
   */
  runStatsBetween(from: Date, to: Date): Promise<RunStatsRow>;
}

/** Run counts and durations, as the Metrics module needs them. Dry runs are excluded. */
export interface RunStatsRow {
  succeeded: number;
  failed: number;
  compensated: number;
  cancelled: number;
  /** Runs not yet finished (pending, running, waiting for approval, compensating), any age. */
  inFlight: number;
  /** finished − started − time waiting for approval, clamped at 0, over succeeded/failed/compensated runs. */
  latency: DurationStat;
  /** Time spent waiting for approval, over those runs that waited at all. */
  approvalWait: DurationStat;
}
