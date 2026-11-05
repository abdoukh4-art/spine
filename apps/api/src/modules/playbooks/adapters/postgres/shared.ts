import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../../../platform/db/schema.js';
import { ValidationError } from '../../../../platform/errors.js';
import { decodeCursor, type Cursor } from '../../../../platform/http/pagination.js';

/** A root Kysely instance or a transaction. */
export type Executor = Kysely<Database>;

/**
 * Runs `fn` in a transaction: a new one on a root instance, or the caller's when the
 * executor already is a transaction (so repositories compose inside a unit of work).
 */
export function inTransaction<T>(db: Executor, fn: (trx: Executor) => Promise<T>): Promise<T> {
  if (db.isTransaction) return fn(db);
  return db.transaction().execute((trx: Transaction<Database>) => fn(trx));
}

/** True for a Postgres unique-violation error. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

/** Converts a nullable Date column to an ISO string. */
export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Decodes a keyset cursor whose sort key is an ISO timestamp. */
export function timestampCursor(raw: string | undefined): { k: Date; id: string } | null {
  if (raw === undefined) return null;
  const cursor: Cursor = decodeCursor(raw);
  const k = new Date(String(cursor.k));
  if (Number.isNaN(k.getTime())) {
    throw new ValidationError('invalid cursor', [
      { path: 'query.cursor', message: 'malformed cursor' },
    ]);
  }
  return { k, id: cursor.id };
}
