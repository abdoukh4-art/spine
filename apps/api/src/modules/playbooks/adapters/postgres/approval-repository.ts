import { ROLES, type Approval, type ApprovalStatus, type Page } from '@spine/shared-schema';
import type { Selectable } from 'kysely';
import type { ApprovalsTable } from '../../../../platform/db/schema.js';
import { paginate } from '../../../../platform/http/pagination.js';
import type { ApprovalRepository, NewApproval } from '../../application/ports.js';
import { iso, timestampCursor, type Executor } from './shared.js';

type Row = Selectable<ApprovalsTable>;

/** `approvals` table: one row per (run, approval step), decided at most once. */
export class PostgresApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Executor) {}

  async createIfMissing(approval: NewApproval): Promise<Approval> {
    await this.db
      .insertInto('approvals')
      .values({
        id: approval.id,
        run_id: approval.runId,
        step_id: approval.stepId,
        alert_id: approval.alertId,
        playbook_id: approval.playbookId,
        approver_role: approval.approverRole,
        prompt: approval.prompt,
        requested_at: approval.requestedAt,
        expires_at: approval.expiresAt,
      })
      .onConflict((oc) => oc.columns(['run_id', 'step_id']).doNothing())
      .execute();
    const row = await this.db
      .selectFrom('approvals')
      .selectAll()
      .where('run_id', '=', approval.runId)
      .where('step_id', '=', approval.stepId)
      .executeTakeFirstOrThrow();
    return toApproval(row);
  }

  async get(id: string): Promise<Approval | null> {
    const row = await this.db
      .selectFrom('approvals')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toApproval(row) : null;
  }

  async getForUpdate(id: string): Promise<Approval | null> {
    const row = await this.db
      .selectFrom('approvals')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row ? toApproval(row) : null;
  }

  async markDecided(
    id: string,
    decision: {
      status: Exclude<ApprovalStatus, 'pending'>;
      decidedBy: string | null;
      comment: string | null;
      at: string;
    },
  ): Promise<Approval> {
    const row = await this.db
      .updateTable('approvals')
      .set({
        status: decision.status,
        decided_by: decision.decidedBy,
        comment: decision.comment,
        decided_at: decision.at,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toApproval(row);
  }

  async expirePendingForRun(runId: string, at: string): Promise<void> {
    await this.db
      .updateTable('approvals')
      .set({ status: 'expired', decided_at: at, comment: 'run cancelled' })
      .where('run_id', '=', runId)
      .where('status', '=', 'pending')
      .execute();
  }

  async list(filter: {
    status?: ApprovalStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<Approval>> {
    let query = this.db.selectFrom('approvals').selectAll();
    if (filter.status) query = query.where('status', '=', filter.status);
    const cursor = timestampCursor(filter.cursor);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('requested_at', '<', cursor.k),
          eb.and([eb('requested_at', '=', cursor.k), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('requested_at', 'desc')
      .orderBy('id', 'desc')
      .limit(filter.limit + 1)
      .execute();
    const page = paginate(rows, filter.limit, (r) => ({
      k: r.requested_at.toISOString(),
      id: r.id,
    }));
    return { items: page.items.map(toApproval), nextCursor: page.nextCursor };
  }

  async dueForExpiry(now: string, limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('approvals')
      .select('id')
      .where('status', '=', 'pending')
      .where('expires_at', '<=', new Date(now))
      .orderBy('expires_at')
      .limit(limit)
      .execute();
    return rows.map((r) => r.id);
  }

  /** Number of approvals waiting for a human (the `spine_approvals_pending` gauge). */
  async countPending(): Promise<number> {
    const row = await this.db
      .selectFrom('approvals')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }
}

function toApproval(row: Row): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    alertId: row.alert_id,
    playbookId: row.playbook_id,
    status: row.status,
    approverRole: ROLES.find((r) => r === row.approver_role) ?? 'admin',
    prompt: row.prompt,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    decidedAt: iso(row.decided_at),
    decidedBy: row.decided_by,
    comment: row.comment,
  };
}
