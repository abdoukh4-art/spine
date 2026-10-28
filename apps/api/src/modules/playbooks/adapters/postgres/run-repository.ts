import {
  ConcurrencyError,
  reduce,
  type LoadedRun,
  type RunEventRecord,
  type RunState,
} from '@spine/playbook-engine';
import {
  PlaybookDefinitionSchema,
  RUN_STATUSES,
  type Page,
  type RunEventType,
  type RunSummary,
} from '@spine/shared-schema';
import type { Selectable } from 'kysely';
import type { EventPublisher } from '../../../../platform/events/types.js';
import { paginate } from '../../../../platform/http/pagination.js';
import type { PlaybookRunsTable } from '../../../../platform/db/schema.js';
import type { NewRun, RunListFilter, RunRepository } from '../../application/ports.js';
import {
  domainEventsFor,
  projectionOf,
  type DomainEventDraft,
  type RunIdentity,
} from '../../domain/run-view.js';
import { inTransaction, isUniqueViolation, iso, timestampCursor, type Executor } from './shared.js';

type RunRow = Selectable<PlaybookRunsTable>;

/** Notified after an append that finished a run (metrics). */
export interface RunFinishedListener {
  runFinished(info: { playbookId: string; status: string; durationMs: number }): void;
}

/** Statuses the startup reconciler re-enqueues: everything but terminal and waiting_approval. */
const RESUMABLE = ['pending', 'running', 'compensating'] as const;

/**
 * Event-sourced run storage (ADR-0010) implementing the engine's `RunStore`.
 *
 * `append` is the heart of it. In ONE transaction it:
 * 1. bumps `playbook_runs.last_seq` from `expectedSeq` — 0 rows updated means another
 *    writer appended first → {@link ConcurrencyError} (the `(run_id, seq)` primary key is a
 *    second line of defence);
 * 2. inserts the events;
 * 3. re-reduces the log and rewrites the projection columns;
 * 4. publishes the implied domain events (approval.requested/decided, run.finished) to
 *    the outbox.
 * So the projection and the outbox can never disagree with the event log.
 */
export class PostgresRunRepository implements RunRepository {
  constructor(
    private readonly db: Executor,
    private readonly events: EventPublisher,
    private readonly listener: RunFinishedListener | null = null,
  ) {}

  async create(run: NewRun): Promise<boolean> {
    return inTransaction(this.db, async (trx) => {
      const inserted = await trx
        .insertInto('playbook_runs')
        .values({
          id: run.id,
          playbook_id: run.playbookId,
          playbook_version: run.playbookVersion,
          alert_id: run.alertId,
          dry_run: run.dryRun,
          status: 'pending',
          current_step_id: null,
          trigger: run.trigger,
          started_by: run.startedBy,
          last_seq: run.started.seq,
          created_at: run.started.occurredAt,
        })
        .onConflict((oc) =>
          oc.columns(['playbook_id', 'alert_id']).where('trigger', '=', 'auto').doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (!inserted) return false;
      await insertEvents(trx, run.id, [run.started]);
      const loaded = await loadWith(trx, run.id);
      if (loaded) await this.project(trx, run.id, reduce(loaded.definition, loaded.events));
      return true;
    });
  }

  async load(runId: string): Promise<LoadedRun | null> {
    return loadWith(this.db, runId);
  }

  async append(
    runId: string,
    expectedSeq: number,
    events: readonly RunEventRecord[],
  ): Promise<void> {
    if (events.length === 0) return;
    const finished = await inTransaction(this.db, async (trx) => {
      const bumped = await trx
        .updateTable('playbook_runs')
        .set({ last_seq: expectedSeq + events.length })
        .where('id', '=', runId)
        .where('last_seq', '=', expectedSeq)
        .returning(['id', 'playbook_id', 'alert_id', 'dry_run'])
        .executeTakeFirst();
      if (!bumped) throw new ConcurrencyError(runId, expectedSeq);
      try {
        await insertEvents(trx, runId, events);
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConcurrencyError(runId, expectedSeq);
        throw err;
      }
      const loaded = await loadWith(trx, runId);
      if (!loaded) throw new Error(`run ${runId} vanished during append`);
      const state = reduce(loaded.definition, loaded.events);
      await this.project(trx, runId, state);
      const identity: RunIdentity = {
        id: runId,
        playbookId: bumped.playbook_id,
        alertId: bumped.alert_id,
        dryRun: bumped.dry_run,
      };
      const drafts = domainEventsFor(identity, events, state);
      await publish(this.events, trx, drafts);
      return drafts.filter((d) => d.type === 'playbook.run.finished');
    });
    for (const draft of finished) {
      if (draft.type !== 'playbook.run.finished') continue;
      const p = draft.payload as { playbookId: string; status: string; durationMs: number };
      this.listener?.runFinished({
        playbookId: p.playbookId,
        status: p.status,
        durationMs: p.durationMs,
      });
    }
  }

  private async project(trx: Executor, runId: string, state: RunState): Promise<void> {
    const p = projectionOf(state);
    await trx
      .updateTable('playbook_runs')
      .set({
        status: p.status,
        current_step_id: p.currentStepId,
        started_at: p.startedAt,
        finished_at: p.finishedAt,
        approval_wait_ms: p.approvalWaitMs,
        last_seq: p.lastSeq,
      })
      .where('id', '=', runId)
      .execute();
  }

  async summary(runId: string): Promise<RunSummary | null> {
    const row = await this.db
      .selectFrom('playbook_runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();
    return row ? toSummary(row) : null;
  }

  async list(filter: RunListFilter): Promise<Page<RunSummary>> {
    let query = this.db.selectFrom('playbook_runs').selectAll();
    if (filter.playbookId) query = query.where('playbook_id', '=', filter.playbookId);
    if (filter.alertId) query = query.where('alert_id', '=', filter.alertId);
    if (filter.status) query = query.where('status', '=', filter.status);
    const cursor = timestampCursor(filter.cursor);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('created_at', '<', cursor.k),
          eb.and([eb('created_at', '=', cursor.k), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(filter.limit + 1)
      .execute();
    const page = paginate(rows, filter.limit, (r) => ({ k: r.created_at.toISOString(), id: r.id }));
    return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
  }

  async forAlert(alertId: string): Promise<RunSummary[]> {
    const rows = await this.db
      .selectFrom('playbook_runs')
      .selectAll()
      .where('alert_id', '=', alertId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(200)
      .execute();
    return rows.map(toSummary);
  }

  async resumable(): Promise<{ id: string; lastSeq: number }[]> {
    const rows = await this.db
      .selectFrom('playbook_runs')
      .select(['id', 'last_seq'])
      .where('status', 'in', [...RESUMABLE])
      .orderBy('created_at')
      .execute();
    return rows.map((r) => ({ id: r.id, lastSeq: r.last_seq }));
  }
}

async function insertEvents(
  trx: Executor,
  runId: string,
  events: readonly RunEventRecord[],
): Promise<void> {
  await trx
    .insertInto('playbook_run_events')
    .values(
      events.map((e) => ({
        run_id: runId,
        seq: e.seq,
        type: e.type,
        step_id: e.stepId,
        payload: JSON.stringify(e.payload),
        occurred_at: e.occurredAt,
      })),
    )
    .execute();
}

async function loadWith(db: Executor, runId: string): Promise<LoadedRun | null> {
  const run = await db
    .selectFrom('playbook_runs')
    .innerJoin('playbooks', (join) =>
      join
        .onRef('playbooks.id', '=', 'playbook_runs.playbook_id')
        .onRef('playbooks.version', '=', 'playbook_runs.playbook_version'),
    )
    .select(['playbooks.definition'])
    .where('playbook_runs.id', '=', runId)
    .executeTakeFirst();
  if (!run) return null;
  const rows = await db
    .selectFrom('playbook_run_events')
    .selectAll()
    .where('run_id', '=', runId)
    .orderBy('seq')
    .execute();
  return {
    definition: PlaybookDefinitionSchema.parse(run.definition),
    events: rows.map((r) => ({
      seq: r.seq,
      type: r.type as RunEventType,
      stepId: r.step_id,
      payload: r.payload,
      occurredAt: r.occurred_at.toISOString(),
    })),
  };
}

async function publish(
  events: EventPublisher,
  trx: Executor,
  drafts: readonly DomainEventDraft[],
): Promise<void> {
  if (drafts.length > 0) await events.publish(trx, drafts);
}

function toSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    playbookVersion: row.playbook_version,
    alertId: row.alert_id,
    status: RUN_STATUSES.find((s) => s === row.status) ?? 'pending',
    dryRun: row.dry_run,
    trigger: row.trigger,
    currentStepId: row.current_step_id,
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}
