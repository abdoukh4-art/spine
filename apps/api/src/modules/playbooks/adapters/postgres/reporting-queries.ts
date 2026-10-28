import type { RunStatus } from '@spine/shared-schema';
import type { Db } from '../../../../platform/db/database.js';
import type { RunTimesRow } from '../../public-api.js';

const IN_FLIGHT: readonly RunStatus[] = ['pending', 'running', 'waiting_approval', 'compensating'];

/**
 * Reporting read model for the Metrics module (ADR-0026, ADR-0029): runs that finished in
 * `[from, to)` plus every run that is still in flight (for the "in flight" counter).
 */
export async function runTimesBetween(db: Db, from: Date, to: Date): Promise<RunTimesRow[]> {
  const rows = await db
    .selectFrom('playbook_runs')
    .select(['status', 'dry_run', 'started_at', 'finished_at', 'approval_wait_ms'])
    .where((eb) =>
      eb.or([
        eb.and([eb('finished_at', '>=', from), eb('finished_at', '<', to)]),
        eb('status', 'in', IN_FLIGHT),
      ]),
    )
    .execute();
  return rows.map((r) => ({
    status: r.status as RunStatus,
    dryRun: r.dry_run,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    approvalWaitMs: Number(r.approval_wait_ms),
  }));
}
