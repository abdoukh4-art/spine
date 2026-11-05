import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { sql } from 'kysely';
import { inject } from 'vitest';
import { createDatabase, type Db } from '../../src/platform/db/database.js';
import { migrate } from '../../src/platform/db/migrator.js';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');

export interface TestDatabase {
  db: Db;
  schema: string;
  url: string;
  /** Drops the schema and closes the pool. Call in afterAll. */
  destroy(): Promise<void>;
}

/**
 * Creates an isolated schema, points a pool at it via search_path, and applies all
 * migrations. Test files can therefore run in parallel against one Postgres server.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const url = inject('databaseUrl');
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = createDatabase({ connectionString: url, poolMax: 1 });
  await sql`create schema ${sql.id(schema)}`.execute(admin);
  await admin.destroy();

  const db = createDatabase({ connectionString: url, schema, poolMax: 5 });
  if (options.migrate !== false) await migrate(db, MIGRATIONS_DIR);
  return {
    db,
    schema,
    url,
    destroy: async () => {
      await sql`drop schema ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    },
  };
}

export function testRedisUrl(): string {
  return inject('redisUrl');
}
