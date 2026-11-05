import type { AuditEntry } from '@spine/shared-schema';
import type { Selectable } from 'kysely';
import type { Db } from '../../../platform/db/database.js';
import type { AuditLogTable } from '../../../platform/db/schema.js';
import { ValidationError } from '../../../platform/errors.js';
import { decodeCursor, paginate } from '../../../platform/http/pagination.js';
import type { AuditFilter, AuditStore, AuditWrite } from '../application/ports.js';

/** User agents are attacker-controlled; keep them bounded. */
const MAX_USER_AGENT_LENGTH = 512;

/** Escapes `%`, `_` and `\` so a user-supplied prefix is matched literally by LIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toEntry(row: Selectable<AuditLogTable>): AuditEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorId: row.actor_id,
    actorType: row.actor_type,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcomeStatus: row.outcome_status,
    requestId: row.request_id,
    ip: row.ip,
    userAgent: row.user_agent,
    details: row.details,
  };
}

/**
 * Postgres implementation of {@link AuditStore} (table `audit_log`). The table is
 * append-only: a trigger rejects UPDATE and DELETE (migration 0100), so this class only
 * ever inserts and selects.
 */
export class PostgresAuditStore implements AuditStore {
  constructor(private readonly db: Db) {}

  /** Inserts one entry, optionally inside the caller's transaction. */
  async append(entry: AuditWrite, executor: Db = this.db): Promise<void> {
    await executor
      .insertInto('audit_log')
      .values({
        occurred_at: entry.occurredAt,
        actor_id: entry.actorId,
        actor_type: entry.actorType,
        action: entry.action,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        outcome_status: entry.outcomeStatus ?? null,
        request_id: entry.requestId ?? null,
        ip: entry.ip ?? null,
        user_agent: entry.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
        details: JSON.stringify(entry.details ?? {}),
      })
      .execute();
  }

  /**
   * Newest first, keyset-paginated on the identity column `id`. `id` is strictly increasing
   * in insertion order and is an exact integer, unlike a microsecond `timestamptz` that would
   * lose precision in a millisecond JS `Date` cursor and skip or repeat rows.
   */
  async query(filter: AuditFilter): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
    let q = this.db
      .selectFrom('audit_log')
      .selectAll()
      .orderBy('id', 'desc')
      .limit(filter.limit + 1);
    if (filter.actorId !== undefined) q = q.where('actor_id', '=', filter.actorId);
    if (filter.action !== undefined) {
      q = q.where('action', 'like', `${escapeLike(filter.action)}%`);
    }
    if (filter.from !== undefined) q = q.where('occurred_at', '>=', filter.from);
    if (filter.to !== undefined) q = q.where('occurred_at', '<', filter.to);
    if (filter.cursor !== undefined) q = q.where('id', '<', cursorId(filter.cursor));
    const rows = await q.execute();
    const page = paginate(rows, filter.limit, (r) => ({ k: null, id: r.id }));
    return { items: page.items.map(toEntry), nextCursor: page.nextCursor };
  }
}

function cursorId(raw: string): string {
  const { id } = decodeCursor(raw);
  if (!/^\d{1,19}$/.test(id)) {
    throw new ValidationError('invalid cursor', [
      { path: 'query.cursor', message: 'malformed cursor' },
    ]);
  }
  return id;
}
