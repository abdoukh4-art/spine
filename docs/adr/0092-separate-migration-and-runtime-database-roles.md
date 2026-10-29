# ADR-0092: Separate migration (owner) and runtime database roles

- **Status:** accepted (refines [ADR-0006](0006-kysely-and-plain-sql-migrations.md), [ADR-0016](0016-authentication-jwt-refresh-rotation.md); closes security review F4)
- **Date:** 2026-10-29
- **Deciders:** maintainers
- **Tags:** security, ops

## Context and problem statement

The audit log is append-only by a trigger (`audit_log_no_update`). The Phase 3 security review
([F4](../security/review-2026-10-28.md)) found that the API and worker connected to Postgres
as the **table owner**, and an owner can run `ALTER TABLE audit_log DISABLE TRIGGER …`. So a
compromised process with arbitrary SQL could rewrite history, which is the exact threat the
audit log exists for. The trigger stopped mistakes, not attackers.

How should Spine connect to the database so the running app _cannot_ tamper with the audit log
or the schema, without making local development painful?

## Decision drivers

- Least privilege for the long-running, internet-facing processes (OWASP ASVS V1.4, V7.3).
- No secrets in migration files or in the repository.
- Works the same in Compose, systemd and a managed Postgres.
- A misconfiguration has to be _visible_ and, in production, has to stop the app (fail closed, like F1).
- `make demo` stays one command.

## Considered options

1. **Two roles, migrate as an admin step.** A NOLOGIN group role `spine_runtime` (created and
   granted by migration 0700) with no UPDATE/DELETE/TRUNCATE on `audit_log`. The login role
   from `DATABASE_URL` is created/updated by the migrate command, which runs as the owner from
   `DATABASE_MIGRATION_URL`. The app checks its own privileges at startup.
2. Same roles, but created by a Postgres init script (`docker-entrypoint-initdb.d`).
3. Keep one role and move the audit log to a separate store (append-only file, WORM bucket, a
   log service).
4. `REVOKE` the trigger-related rights from the owner. Not possible: ownership implies them.

## Decision outcome

**Option 1.**

- Migration `0700_runtime_role.sql` creates `spine_runtime` if missing (roles are cluster-wide,
  so creation tolerates a concurrent duplicate), grants `SELECT/INSERT/UPDATE/DELETE` on the schema's
  tables and sequences plus `ALTER DEFAULT PRIVILEGES` for future tables, then revokes
  `UPDATE, DELETE, TRUNCATE` on `audit_log` and every write on `schema_migrations`.
- `dist/cli/migrate.js` (Compose service `migrate`, systemd unit `spine-migrate`) runs migrations
  with `DATABASE_MIGRATION_URL`, then creates or updates the login role named in `DATABASE_URL`
  (password from the URL, quoted by Postgres with `format('%I', '%L')`), grants it `spine_runtime`
  and `CONNECT`. Re-running it rotates the password.
- The API and worker run `checkRuntimeRole` at startup: owner, superuser or UPDATE/DELETE on
  `audit_log` → **refuse in production** (`PrivilegedDatabaseRoleError`) unless
  `DB_ALLOW_PRIVILEGED_ROLE=true`. Elsewhere it logs a warning.
- Development without `DATABASE_MIGRATION_URL` keeps working with one role (`MIGRATE_ON_START=true`).

Option 2 only runs on an empty data directory, so it does nothing for existing installs and
doesn't exist on managed Postgres. Option 3 is the stronger long-term answer (tamper-evidence
outside the database), but it's a new component, and it still leaves the schema writable by the
app. Option 4 doesn't work.

### Consequences

- 👍 The F4 attack fails: `ALTER TABLE audit_log DISABLE TRIGGER` → `must be owner of table
audit_log`; `UPDATE audit_log` → `permission denied` (privilege check before the trigger).
  Integration-tested, mutation-checked (dropping the `REVOKE` fails two tests), and checked on
  the live Compose stack.
- 👍 The app can't change the schema or forge migration history either.
- 👎 One more secret (`SPINE_APP_DB_PASSWORD`) and one more process to run on deploy.
- 👎 `CREATE/ALTER ROLE … PASSWORD` sends the password to the server as statement text: it can
  appear in the Postgres log if `log_statement` is set to `ddl` or `all` (the default, `none`,
  doesn't log it). Keep DDL logging off on the server that runs migrate.
- 👎 The owner needs `CREATEROLE` (true for the Compose superuser; on managed Postgres, run
  migrate with the provider's admin user).
- ⚖️ Backups: `pg_dump` contains GRANTs to `spine_runtime`, but roles live in the cluster. On a
  new cluster, create `spine_runtime` before `pg_restore` ([backup-restore.md](../operations/backup-restore.md)).
- ⚖️ The owner (a DBA, or anyone with owner credentials) can still rewrite history. Protecting
  against that needs option 3.

## What would make us revisit this

- A compliance requirement for tamper-_evident_ audit (hash chain, external WORM storage) → option 3.
- Multiple Spine databases in one cluster needing different runtime privileges → per-database group roles.
- Managed Postgres without `CREATEROLE` → a "grant-only" mode for the migrate command.

## Further reading

- PostgreSQL docs: _Privileges_ (§5.8), _ALTER DEFAULT PRIVILEGES_, _Role Membership_
- OWASP ASVS 4.0: V1.4 (access control architecture), V7.3 (log protection)
