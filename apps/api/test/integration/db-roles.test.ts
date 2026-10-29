import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/platform/config.js';
import { createDatabase, type Db } from '../../src/platform/db/database.js';
import { checkRuntimeRole, PrivilegedDatabaseRoleError } from '../../src/platform/db/prepare.js';
import { createLogger } from '../../src/platform/logger.js';
import {
  ensureRuntimeLogin,
  inspectRuntimePrivileges,
  isPrivileged,
} from '../../src/platform/db/roles.js';
import { testConfig } from '../support/config.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';

/**
 * Security review F4 / ADR-0092: the runtime role can append to the audit log but can't rewrite
 * it, and can't switch off the append-only trigger. Each claim is tested as the attack itself.
 */
describe('database role separation (ADR-0092)', () => {
  let owner: TestDatabase;
  let runtime: Db;
  const role = `spine_app_${randomBytes(4).toString('hex')}`;
  // Includes a quote and a backslash: the password is quoted by Postgres, not by us.
  const password = `pw'${randomBytes(8).toString('hex')}\\x`;

  function runtimeUrl(pw = password): string {
    const url = new URL(owner.url);
    url.username = role;
    url.password = pw;
    return url.toString();
  }

  beforeAll(async () => {
    owner = await createTestDatabase();
    const result = await ensureRuntimeLogin(owner.db, owner.url, runtimeUrl());
    expect(result).toEqual({ status: 'created', role });
    runtime = createDatabase({ connectionString: runtimeUrl(), schema: owner.schema, poolMax: 2 });
  });

  afterAll(async () => {
    await runtime.destroy();
    await sql`drop owned by ${sql.id(role)}`.execute(owner.db);
    await sql`drop role ${sql.id(role)}`.execute(owner.db);
    await owner.destroy();
  });

  async function insertAuditRow(db: Db): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into audit_log (actor_type, action, outcome_status)
      values ('system', 'test.db_roles', 200)
      returning id::text as id`.execute(db);
    return rows[0]!.id;
  }

  it('lets the runtime role read and write application tables and append audit rows', async () => {
    await expect(insertAuditRow(runtime)).resolves.toBeTruthy();
    await expect(sql`select count(*) from alerts`.execute(runtime)).resolves.toBeDefined();
    await expect(
      sql`select filename from schema_migrations`.execute(runtime),
    ).resolves.toBeDefined();
  });

  it('refuses UPDATE and DELETE on the audit log by privilege, before any trigger runs', async () => {
    const id = await insertAuditRow(runtime);
    await expect(
      sql`update audit_log set action = 'forged' where id = ${id}::bigint`.execute(runtime),
    ).rejects.toThrow(/permission denied for table audit_log/);
    await expect(
      sql`delete from audit_log where id = ${id}::bigint`.execute(runtime),
    ).rejects.toThrow(/permission denied for table audit_log/);
    await expect(sql`truncate audit_log`.execute(runtime)).rejects.toThrow(/permission denied/);
  });

  it('cannot disable the append-only trigger (the F4 attack)', async () => {
    await expect(
      sql`alter table audit_log disable trigger audit_log_no_update`.execute(runtime),
    ).rejects.toThrow(/must be owner/);
  });

  it('cannot write the migration history or change the schema', async () => {
    await expect(
      sql`insert into schema_migrations (filename, checksum) values ('9999_evil.sql', 'x')`.execute(
        runtime,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(sql`create table evil (id int)`.execute(runtime)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('sees tables created by later migrations (default privileges)', async () => {
    await sql`create table later_migration_table (id int)`.execute(owner.db);
    await expect(
      sql`insert into later_migration_table values (1)`.execute(runtime),
    ).resolves.toBeDefined();
  });

  it('reports the runtime role as least-privilege and the owner as privileged', async () => {
    const runtimePrivileges = await inspectRuntimePrivileges(runtime);
    expect(runtimePrivileges).toMatchObject({
      role,
      superuser: false,
      ownsAuditLog: false,
      canRewriteAuditLog: false,
    });
    expect(isPrivileged(runtimePrivileges)).toBe(false);
    expect(isPrivileged(await inspectRuntimePrivileges(owner.db))).toBe(true);
  });

  it('rotates the password when re-run with a new one, and is a no-op for a single-role setup', async () => {
    const rotated = `rotated-${randomBytes(8).toString('hex')}`;
    await expect(ensureRuntimeLogin(owner.db, owner.url, runtimeUrl(rotated))).resolves.toEqual({
      status: 'updated',
      role,
    });
    const withNewPassword = createDatabase({
      connectionString: runtimeUrl(rotated),
      schema: owner.schema,
      poolMax: 1,
    });
    try {
      await expect(sql`select 1`.execute(withNewPassword)).resolves.toBeDefined();
    } finally {
      await withNewPassword.destroy();
    }
    await expect(ensureRuntimeLogin(owner.db, owner.url, owner.url)).resolves.toMatchObject({
      status: 'same-role',
    });
  });

  describe('startup guard', () => {
    const logger = createLogger(testConfig());
    const production = (overrides: Partial<Config> = {}): Config => ({
      ...testConfig(),
      NODE_ENV: 'production',
      ...overrides,
    });

    it('refuses to start in production as a role that can rewrite the audit log', async () => {
      await expect(checkRuntimeRole(owner.db, production(), logger)).rejects.toBeInstanceOf(
        PrivilegedDatabaseRoleError,
      );
    });

    it('starts in production as the runtime role, or when the risk is explicitly accepted', async () => {
      await expect(checkRuntimeRole(runtime, production(), logger)).resolves.toBeUndefined();
      await expect(
        checkRuntimeRole(owner.db, production({ DB_ALLOW_PRIVILEGED_ROLE: true }), logger),
      ).resolves.toBeUndefined();
    });

    it('only warns outside production (single-role development)', async () => {
      await expect(checkRuntimeRole(owner.db, testConfig(), logger)).resolves.toBeUndefined();
    });
  });
});
