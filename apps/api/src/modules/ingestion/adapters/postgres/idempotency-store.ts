import { IngestResultSchema } from '@spine/shared-schema';
import type { Db } from '../../../../platform/db/database.js';
import type { DbExecutor } from '../../../../platform/events/types.js';
import type { IdempotencyStore, StoredResponse } from '../../application/ports.js';

/** Kysely implementation of {@link IdempotencyStore} over `idempotency_keys` (migration 0300). */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Db) {}

  async find(
    trx: DbExecutor,
    scope: string,
    key: string,
    notBefore: Date,
  ): Promise<StoredResponse | null> {
    const row = await trx
      .selectFrom('idempotency_keys')
      .select(['request_hash', 'response_status', 'response_body'])
      .where('scope', '=', scope)
      .where('key', '=', key)
      .where('created_at', '>=', notBefore)
      .executeTakeFirst();
    if (!row) return null;
    return {
      requestHash: row.request_hash,
      status: row.response_status,
      // Stored by us, but parsed anyway: a replay must never send a shape the contract forbids.
      body: IngestResultSchema.parse(row.response_body),
    };
  }

  /**
   * `INSERT … ON CONFLICT DO UPDATE … WHERE created_at < expiry`: takes over an expired
   * record in place, but leaves a live one alone (zero rows returned → `false`). If the
   * conflicting row belongs to a transaction still in flight, Postgres waits for it to finish.
   */
  async save(
    trx: DbExecutor,
    record: { scope: string; key: string; response: StoredResponse; createdAt: Date },
    expiredBefore: Date,
  ): Promise<boolean> {
    const row = await trx
      .insertInto('idempotency_keys')
      .values({
        scope: record.scope,
        key: record.key,
        request_hash: record.response.requestHash,
        response_status: record.response.status,
        response_body: JSON.stringify(record.response.body),
        created_at: record.createdAt,
      })
      .onConflict((oc) =>
        oc
          .columns(['scope', 'key'])
          .doUpdateSet((eb) => ({
            request_hash: eb.ref('excluded.request_hash'),
            response_status: eb.ref('excluded.response_status'),
            response_body: eb.ref('excluded.response_body'),
            created_at: eb.ref('excluded.created_at'),
          }))
          .where('idempotency_keys.created_at', '<', expiredBefore),
      )
      .returning('scope')
      .executeTakeFirst();
    return row !== undefined;
  }

  async deleteExpired(expiredBefore: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('idempotency_keys')
      .where('created_at', '<', expiredBefore)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
