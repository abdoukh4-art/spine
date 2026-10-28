import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'kysely';
import type { Db } from './database.js';

/**
 * Minimal forward-only SQL migrator (ADR-0006).
 *
 * - Applies `NNNN_*.sql` files in lexical order, each in its own transaction.
 * - Records filename + SHA-256 checksum in `schema_migrations`.
 * - Refuses to continue if an already-applied file's checksum changed: editing history
 *   is a bug — write a new migration instead.
 * - Takes a Postgres advisory lock so two instances starting at once don't race.
 */

const MIGRATION_LOCK_ID = 727_001; // arbitrary, stable
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationChecksumError extends Error {
  constructor(filename: string) {
    super(
      `Migration ${filename} was modified after being applied. Create a new migration instead.`,
    );
    this.name = 'MigrationChecksumError';
  }
}

/** Lists migration files in a directory, sorted. Non-matching files are ignored. */
export async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => FILE_PATTERN.test(f)).sort();
}

/** Applies pending migrations from `dir`. Safe to call on every startup. */
export async function migrate(db: Db, dir: string): Promise<MigrationResult> {
  return db.connection().execute(async (conn) => {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`.execute(conn);
    try {
      await sql`
        create table if not exists schema_migrations (
          filename text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )`.execute(conn);

      const applied = new Map(
        (await conn.selectFrom('schema_migrations').select(['filename', 'checksum']).execute()).map(
          (r) => [r.filename, r.checksum],
        ),
      );
      const result: MigrationResult = { applied: [], alreadyApplied: [] };

      for (const file of await listMigrationFiles(dir)) {
        const content = await readFile(path.join(dir, file), 'utf8');
        const checksum = createHash('sha256').update(content).digest('hex');
        const previous = applied.get(file);
        if (previous !== undefined) {
          if (previous !== checksum) throw new MigrationChecksumError(file);
          result.alreadyApplied.push(file);
          continue;
        }
        await conn.transaction().execute(async (trx) => {
          await sql.raw(content).execute(trx);
          await trx.insertInto('schema_migrations').values({ filename: file, checksum }).execute();
        });
        result.applied.push(file);
      }
      return result;
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`.execute(conn);
    }
  });
}

/** True when every migration file in `dir` has been applied (used by /readyz). */
export async function migrationsUpToDate(db: Db, dir: string): Promise<boolean> {
  try {
    const files = await listMigrationFiles(dir);
    const rows = await db.selectFrom('schema_migrations').select('filename').execute();
    const applied = new Set(rows.map((r) => r.filename));
    return files.every((f) => applied.has(f));
  } catch {
    return false;
  }
}
