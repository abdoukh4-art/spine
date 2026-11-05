import { sql } from 'kysely';
import type { Db } from './database.js';

/**
 * Database role separation (ADR-0092, security review F4).
 *
 * - The **owner** (migration) role creates and alters tables. Only the migrate command uses it.
 * - The **runtime** login role (`DATABASE_URL`) is a member of `spine_runtime` (migration 0700):
 *   read/write on application tables, insert-only on `audit_log`, owns nothing.
 */

/** The NOLOGIN group role created by migration 0700. */
export const RUNTIME_GROUP_ROLE = 'spine_runtime';

export type RuntimeLoginResult =
  | { status: 'same-role'; role: string }
  | { status: 'created' | 'updated'; role: string };

/** Extracts the login role and password from a `postgres://user:password@host/db` URL. */
export function credentialsFromUrl(url: string): { user: string; password: string } {
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

/**
 * Makes sure the runtime login role from `runtimeUrl` exists, has the password from that URL
 * (so rotating the secret and re-running migrate is enough), and is a member of
 * `spine_runtime`. Runs as the owner. Does nothing when both URLs use the same role (the
 * single-role development setup).
 *
 * DDL can't take bind parameters, so identifiers and the password are quoted by Postgres itself
 * with `format('%I', '%L')`, never by string concatenation.
 */
export async function ensureRuntimeLogin(
  ownerDb: Db,
  ownerUrl: string,
  runtimeUrl: string,
): Promise<RuntimeLoginResult> {
  const owner = credentialsFromUrl(ownerUrl).user;
  const { user, password } = credentialsFromUrl(runtimeUrl);
  if (user === owner) return { status: 'same-role', role: user };
  if (!password) throw new Error('DATABASE_URL must include a password for the runtime role');

  const exists = await sql<{ exists: boolean }>`
    select exists (select from pg_roles where rolname = ${user}) as exists`.execute(ownerDb);
  const created = !exists.rows[0]?.exists;
  const ddl = created
    ? sql<{
        stmt: string;
      }>`select format('CREATE ROLE %I LOGIN PASSWORD %L', ${user}::text, ${password}::text) as stmt`
    : sql<{
        stmt: string;
      }>`select format('ALTER ROLE %I WITH LOGIN PASSWORD %L', ${user}::text, ${password}::text) as stmt`;
  const grant = sql<{ stmt: string }>`
    select format('GRANT %I TO %I', ${RUNTIME_GROUP_ROLE}::text, ${user}::text) as stmt`;
  const connect = sql<{ stmt: string }>`
    select format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${user}::text) as stmt`;

  await ownerDb.transaction().execute(async (trx) => {
    for (const statement of [ddl, grant, connect]) {
      const { rows } = await statement.execute(trx);
      const stmt = rows[0]?.stmt;
      if (!stmt) throw new Error('format() returned no statement');
      await sql.raw(stmt).execute(trx);
    }
  });
  return { status: created ? 'created' : 'updated', role: user };
}

export interface RuntimePrivileges {
  role: string;
  superuser: boolean;
  /** True when the role owns `audit_log` (and could disable its trigger). */
  ownsAuditLog: boolean;
  /** True when the role may UPDATE or DELETE audit rows. */
  canRewriteAuditLog: boolean;
}

/** Reports what the connected role could do to the audit log. Run after migrations. */
export async function inspectRuntimePrivileges(db: Db): Promise<RuntimePrivileges> {
  const { rows } = await sql<{
    role: string;
    superuser: boolean;
    owns: boolean | null;
    can_rewrite: boolean | null;
  }>`
    select current_user as role,
           (select rolsuper from pg_roles where rolname = current_user) as superuser,
           pg_has_role(current_user, (select relowner from pg_class
                                      where oid = to_regclass('audit_log')), 'USAGE') as owns,
           case when to_regclass('audit_log') is null then null
                else has_table_privilege(to_regclass('audit_log'), 'UPDATE')
                  or has_table_privilege(to_regclass('audit_log'), 'DELETE') end as can_rewrite
  `.execute(db);
  const row = rows[0];
  if (!row) throw new Error('privilege query returned no row');
  return {
    role: row.role,
    superuser: row.superuser,
    ownsAuditLog: row.owns ?? false,
    canRewriteAuditLog: row.can_rewrite ?? false,
  };
}

/** True when the role can tamper with the audit log (owner, superuser or UPDATE/DELETE). */
export function isPrivileged(p: RuntimePrivileges): boolean {
  return p.superuser || p.ownsAuditLog || p.canRewriteAuditLog;
}
