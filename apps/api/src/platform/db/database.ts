import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;

// node-postgres returns int8 (bigint) as string by default to avoid precision loss; we keep
// that default and parse count(*) results explicitly where needed.

export interface DatabaseOptions {
  connectionString: string;
  poolMax?: number;
  /** Postgres `search_path` (used by tests to isolate each file in its own schema). */
  schema?: string;
  applicationName?: string;
}

/** Creates a Kysely instance backed by a node-postgres pool. Call `destroy()` on shutdown. */
export function createDatabase(options: DatabaseOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    application_name: options.applicationName ?? 'spine',
    // Fail fast rather than queueing forever when the DB is unreachable (resilience).
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    ...(options.schema ? { options: `-c search_path=${options.schema},public` } : {}),
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Cheap connectivity probe for readiness checks. */
export async function pingDatabase(db: Db): Promise<boolean> {
  try {
    await sql`select 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}
