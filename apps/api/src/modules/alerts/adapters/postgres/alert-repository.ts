import type { Alert, AlertListQuery, AlertSummary, MitreMapping, Page } from '@spine/shared-schema';
import { sql, type ExpressionBuilder, type SelectQueryBuilder } from 'kysely';
import type { Database } from '../../../../platform/db/schema.js';
import { ValidationError } from '../../../../platform/errors.js';
import type { DbExecutor } from '../../../../platform/events/types.js';
import { decodeCursor, paginate, type Cursor } from '../../../../platform/http/pagination.js';
import { OpenAlertExistsError } from '../../application/errors.js';
import type { AlertPatch, AlertRepository, LockedAlert } from '../../application/ports.js';
import { likePattern, tacticFilterIds, techniqueFilterIds } from '../../domain/mitre-index.js';
import {
  canonicalPart,
  iso,
  isoOrNull,
  isUniqueViolation,
  SUMMARY_COLUMNS,
  toAlert,
  toSummary,
} from './rows.js';

const OPEN_FINGERPRINT_INDEX = 'alerts_open_fingerprint_uq';
const CLOSED = ['resolved', 'false_positive'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AlertsSelect = SelectQueryBuilder<Database, 'alerts', object>;

function summarySelect(executor: DbExecutor) {
  return executor
    .selectFrom('alerts')
    .select(SUMMARY_COLUMNS)
    .select(sql<MitreMapping[] | null>`canonical -> 'mitre'`.as('mitre'));
}

function invalidCursor(message: string): ValidationError {
  return new ValidationError('invalid cursor', [{ path: 'query.cursor', message }]);
}

/** Decodes a cursor and checks it was produced by the same sort mode. */
function cursorFor(query: AlertListQuery): Cursor | null {
  if (query.cursor === undefined) return null;
  const cursor = decodeCursor(query.cursor);
  if (!UUID.test(cursor.id)) throw invalidCursor('malformed cursor');
  if (query.sort === 'receivedAt') {
    if (typeof cursor.k !== 'string' || Number.isNaN(Date.parse(cursor.k))) {
      throw invalidCursor('cursor does not belong to sort=receivedAt');
    }
  } else if (cursor.k !== null && typeof cursor.k !== 'number') {
    throw invalidCursor('cursor does not belong to sort=score');
  }
  return cursor;
}

function applyFilters(q: AlertsSelect, query: AlertListQuery): AlertsSelect {
  let out = q;
  if (query.status?.length) out = out.where('status', 'in', query.status);
  if (query.severity?.length) {
    // Effective severity: the scored one, or the source's until scoring has run (ADR-0037).
    const list = query.severity;
    out = out.where((eb) => eb(sql<string>`coalesce(severity, source_severity)`, 'in', list));
  }
  if (query.category) out = out.where('category', '=', query.category);
  if (query.minScore !== undefined) out = out.where('score', '>=', query.minScore);
  if (query.maxScore !== undefined) out = out.where('score', '<=', query.maxScore);
  if (query.source) {
    const s = query.source.toLowerCase();
    out = out.where((eb) =>
      eb.or([
        eb(eb.fn('lower', ['source_vendor']), '=', s),
        eb(eb.fn('lower', ['source_product']), '=', s),
      ]),
    );
  }
  if (query.q) out = out.where('title', 'ilike', likePattern(query.q));
  if (query.from) out = out.where('received_at', '>=', new Date(query.from));
  if (query.to) out = out.where('received_at', '<', new Date(query.to));
  if (query.assigneeId) out = out.where('assignee_id', '=', query.assigneeId);
  if (query.technique) {
    const t = query.technique.toUpperCase();
    out = out.where(sql<boolean>`mitre_technique_ids @> ARRAY[${t}]::text[]`);
  }
  return out;
}

/**
 * Keyset predicate for `ORDER BY score {dir} NULLS LAST, id {dir}` (ADR-0037). NULL scores
 * (not scored yet) sort after every number in both directions, so "after the cursor" is:
 * - cursor on a number k: a score strictly past k, or equal to k with a later id, or any NULL;
 * - cursor on NULL:       a NULL score with a later id (numbers are all behind us).
 * A plain `(score, id) < (k, id)` tuple comparison gets this wrong: NULL compares as unknown.
 */
function scoreKeyset(cursor: Cursor, desc: boolean) {
  const op = desc ? '<' : '>';
  return (eb: ExpressionBuilder<Database, 'alerts'>) => {
    if (cursor.k === null) {
      return eb.and([eb('score', 'is', null), eb('id', op, cursor.id)]);
    }
    const k = cursor.k as number;
    return eb.or([
      eb('score', op, k),
      eb.and([eb('score', '=', k), eb('id', op, cursor.id)]),
      eb('score', 'is', null),
    ]);
  };
}

function applyOrder(q: AlertsSelect, query: AlertListQuery, cursor: Cursor | null): AlertsSelect {
  const desc = query.order === 'desc';
  if (query.sort === 'receivedAt') {
    let out = q;
    if (cursor) {
      const at = new Date(cursor.k as string);
      out = out.where((eb) =>
        eb(eb.refTuple('received_at', 'id'), desc ? '<' : '>', eb.tuple(at, cursor.id)),
      );
    }
    return out.orderBy('received_at', query.order).orderBy('id', query.order);
  }
  const out = cursor ? q.where(scoreKeyset(cursor, desc)) : q;
  return out
    .orderBy('score', (ob) => (desc ? ob.desc() : ob.asc()).nullsLast())
    .orderBy('id', query.order);
}

/** Kysely implementation of {@link AlertRepository}. */
export class PostgresAlertRepository implements AlertRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(trx: DbExecutor, alert: Alert): Promise<void> {
    try {
      await trx
        .insertInto('alerts')
        .values({
          id: alert.id,
          fingerprint: alert.fingerprint,
          status: alert.status,
          title: alert.title,
          category: alert.category,
          source_vendor: alert.source.vendor,
          source_product: alert.source.product,
          source_severity: alert.severity,
          occurred_at: alert.occurredAt,
          received_at: alert.receivedAt,
          last_seen_at: alert.lastSeenAt,
          duplicate_count: alert.duplicateCount,
          canonical: JSON.stringify(canonicalPart(alert)),
          mitre_technique_ids: techniqueFilterIds(alert.mitre),
          mitre_tactic_ids: tacticFilterIds(alert.mitre),
          updated_at: alert.receivedAt,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error, OPEN_FINGERPRINT_INDEX)) {
        throw new OpenAlertExistsError(alert.fingerprint);
      }
      throw error;
    }
  }

  async lockOpenByFingerprint(trx: DbExecutor, fingerprint: string) {
    const row = await trx
      .selectFrom('alerts')
      .select(['id', 'duplicate_count'])
      .where('fingerprint', '=', fingerprint)
      .where('status', 'not in', CLOSED)
      .forUpdate()
      .executeTakeFirst();
    return row ? { id: row.id, duplicateCount: row.duplicate_count } : null;
  }

  async recordDuplicate(trx: DbExecutor, alertId: string, seenAt: string) {
    const row = await trx
      .updateTable('alerts')
      .set({
        duplicate_count: sql<number>`duplicate_count + 1`,
        last_seen_at: sql<Date>`greatest(last_seen_at, ${seenAt}::timestamptz)`,
        updated_at: seenAt,
      })
      .where('id', '=', alertId)
      .returning(['duplicate_count', 'last_seen_at'])
      .executeTakeFirstOrThrow();
    return { duplicateCount: row.duplicate_count, lastSeenAt: iso(row.last_seen_at) };
  }

  async getAlert(executor: DbExecutor, alertId: string): Promise<Alert | null> {
    const row = await executor
      .selectFrom('alerts')
      .select([
        'id',
        'fingerprint',
        'status',
        'received_at',
        'last_seen_at',
        'duplicate_count',
        'canonical',
      ])
      .where('id', '=', alertId)
      .executeTakeFirst();
    return row ? toAlert(row) : null;
  }

  async getSummary(executor: DbExecutor, alertId: string): Promise<AlertSummary | null> {
    const row = await summarySelect(executor).where('id', '=', alertId).executeTakeFirst();
    return row ? toSummary(row) : null;
  }

  async lock(trx: DbExecutor, alertId: string): Promise<LockedAlert | null> {
    const row = await trx
      .selectFrom('alerts')
      .select(['id', 'fingerprint', 'status', 'resolved_at', 'assignee_id', 'case_id'])
      .where('id', '=', alertId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      status: row.status,
      resolvedAt: isoOrNull(row.resolved_at),
      assigneeId: row.assignee_id,
      caseId: row.case_id,
    };
  }

  async update(trx: DbExecutor, alertId: string, patch: AlertPatch): Promise<void> {
    try {
      await trx
        .updateTable('alerts')
        .set({
          updated_at: patch.updatedAt,
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.resolvedAt !== undefined ? { resolved_at: patch.resolvedAt } : {}),
          ...(patch.assigneeId !== undefined ? { assignee_id: patch.assigneeId } : {}),
          ...(patch.caseId !== undefined ? { case_id: patch.caseId } : {}),
        })
        .where('id', '=', alertId)
        .execute();
    } catch (error) {
      if (isUniqueViolation(error, OPEN_FINGERPRINT_INDEX)) throw new OpenAlertExistsError('');
      throw error;
    }
  }

  async list(query: AlertListQuery): Promise<Page<AlertSummary>> {
    const cursor = cursorFor(query);
    const base = applyFilters(this.db.selectFrom('alerts') as AlertsSelect, query);
    const rows = await applyOrder(base, query, cursor)
      .select(SUMMARY_COLUMNS)
      .select(sql<MitreMapping[] | null>`canonical -> 'mitre'`.as('mitre'))
      .limit(query.limit + 1)
      .execute();
    const page = paginate(rows, query.limit, (row) => ({
      k: query.sort === 'receivedAt' ? iso(row.received_at) : row.score,
      id: row.id,
    }));
    return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
  }

  async projectScore(
    alertId: string,
    score: { score: number; severity: string; computedAt: string },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('alerts')
      .set({ score: score.score, severity: score.severity, scored_at: score.computedAt })
      .where('id', '=', alertId)
      .where((eb) =>
        eb.or([eb('scored_at', 'is', null), eb('scored_at', '<=', new Date(score.computedAt))]),
      )
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async existingIds(trx: DbExecutor, alertIds: readonly string[]): Promise<string[]> {
    if (alertIds.length === 0) return [];
    const rows = await trx.selectFrom('alerts').select('id').where('id', 'in', alertIds).execute();
    return rows.map((r) => r.id);
  }

  async setCase(
    trx: DbExecutor,
    alertIds: readonly string[],
    caseId: string | null,
    at: string,
    onlyCaseId?: string,
  ): Promise<void> {
    if (alertIds.length === 0) return;
    let q = trx
      .updateTable('alerts')
      .set({ case_id: caseId, updated_at: at })
      .where('id', 'in', alertIds);
    if (onlyCaseId !== undefined) q = q.where('case_id', '=', onlyCaseId);
    await q.execute();
  }

  async alertIdsByCase(executor: DbExecutor, caseIds: readonly string[]) {
    const out = new Map<string, string[]>();
    if (caseIds.length === 0) return out;
    const rows = await executor
      .selectFrom('alerts')
      .select(['id', 'case_id'])
      .where('case_id', 'in', caseIds)
      .orderBy('received_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    for (const row of rows) {
      if (row.case_id === null) continue;
      const list = out.get(row.case_id) ?? [];
      list.push(row.id);
      out.set(row.case_id, list);
    }
    return out;
  }

  async summariesForCase(executor: DbExecutor, caseId: string): Promise<AlertSummary[]> {
    const rows = await summarySelect(executor)
      .where('case_id', '=', caseId)
      .orderBy('received_at', 'desc')
      .orderBy('id', 'desc')
      .limit(500)
      .execute();
    return rows.map(toSummary);
  }
}
