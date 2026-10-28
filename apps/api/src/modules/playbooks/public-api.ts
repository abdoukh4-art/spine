import type { RunStatus, RunSummary } from '@spine/shared-schema';

/** Public API of the Playbooks module. Other modules may import ONLY this file. */
export interface PlaybooksPublicApi {
  /** Runs started for an alert, newest first. */
  runsForAlert(alertId: string): Promise<RunSummary[]>;
  /** Runs finished in [from, to) plus all in-flight runs, for the Metrics module (ADR-0026). */
  runTimesBetween(from: Date, to: Date): Promise<RunTimesRow[]>;
}

/** One run's timing fields, as the Metrics module needs them. */
export interface RunTimesRow {
  status: RunStatus;
  dryRun: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  approvalWaitMs: number;
}
