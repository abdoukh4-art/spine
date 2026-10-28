import type { RunSummary } from '@spine/shared-schema';

/** Public API of the Playbooks module. Other modules may import ONLY this file. */
export interface PlaybooksPublicApi {
  /** Runs started for an alert, newest first. */
  runsForAlert(alertId: string): Promise<RunSummary[]>;
}
