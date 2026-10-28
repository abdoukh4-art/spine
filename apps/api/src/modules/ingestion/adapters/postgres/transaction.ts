import type { Db } from '../../../../platform/db/database.js';
import type { DbExecutor } from '../../../../platform/events/types.js';
import type { TransactionRunner } from '../../application/ports.js';

/** {@link TransactionRunner} backed by a Kysely transaction (READ COMMITTED, Postgres' default). */
export function kyselyTransactionRunner(db: Db): TransactionRunner {
  return {
    run: <T>(fn: (trx: DbExecutor) => Promise<T>): Promise<T> => db.transaction().execute(fn),
  };
}
