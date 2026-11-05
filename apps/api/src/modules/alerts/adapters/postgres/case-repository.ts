import type { CaseListQuery, CaseStatus, Page } from '@spine/shared-schema';
import { ValidationError } from '../../../../platform/errors.js';
import type { DbExecutor } from '../../../../platform/events/types.js';
import { decodeCursor, paginate } from '../../../../platform/http/pagination.js';
import type { CaseRecord, CaseRepository } from '../../application/ports.js';
import { iso, toCaseRecord } from './rows.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kysely implementation of {@link CaseRepository}. */
export class PostgresCaseRepository implements CaseRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(trx: DbExecutor, record: CaseRecord): Promise<void> {
    await trx
      .insertInto('cases')
      .values({
        id: record.id,
        title: record.title,
        description: record.description,
        status: record.status,
        created_by: record.createdBy,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .execute();
  }

  async get(
    executor: DbExecutor,
    caseId: string,
    options: { lock?: boolean } = {},
  ): Promise<CaseRecord | null> {
    let q = executor.selectFrom('cases').selectAll().where('id', '=', caseId);
    if (options.lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    return row ? toCaseRecord(row) : null;
  }

  async update(
    trx: DbExecutor,
    caseId: string,
    patch: { title?: string; description?: string; status?: CaseStatus; updatedAt: string },
  ): Promise<void> {
    await trx
      .updateTable('cases')
      .set({
        updated_at: patch.updatedAt,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      })
      .where('id', '=', caseId)
      .execute();
  }

  /** Newest first: `ORDER BY created_at DESC, id DESC` with a keyset cursor. */
  async list(query: CaseListQuery): Promise<Page<CaseRecord>> {
    let q = this.db.selectFrom('cases').selectAll();
    if (query.status) q = q.where('status', '=', query.status);
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      if (
        typeof cursor.k !== 'string' ||
        Number.isNaN(Date.parse(cursor.k)) ||
        !UUID.test(cursor.id)
      ) {
        throw new ValidationError('invalid cursor', [
          { path: 'query.cursor', message: 'malformed cursor' },
        ]);
      }
      const at = new Date(cursor.k);
      q = q.where((eb) => eb(eb.refTuple('created_at', 'id'), '<', eb.tuple(at, cursor.id)));
    }
    const rows = await q
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = paginate(rows, query.limit, (row) => ({ k: iso(row.created_at), id: row.id }));
    return { items: page.items.map(toCaseRecord), nextCursor: page.nextCursor };
  }
}
