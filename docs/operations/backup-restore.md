# Backup and restore

## What to back up

| Data                                           | Where                          | Back up?                    | Why                                                                                   |
| ---------------------------------------------- | ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------- |
| PostgreSQL database `spine`                    | `pgdata` volume / your DB host | **Yes: the only must-have** | System of record: alerts, runs (event-sourced), users, audit log, outbox (ADR-0007)   |
| Configuration (`.env`, `/etc/spine/spine.env`) | host                           | Yes, in a secret store      | Secrets (`AUTH_JWT_SECRET`, webhook secrets). Losing the JWT secret logs everyone out |
| TLS key and certificate                        | `infra/tls/` or your PKI       | Yes (or re-issue)           |                                                                                       |
| Redis                                          | `redisdata` volume             | No                          | Re-creatable queue state (ADR-0008); see [Redis wiped](runbooks.md#redis-wiped)       |
| Prometheus / Grafana data                      | volumes                        | Optional                    | Metrics history; dashboards and datasources are provisioned from the repo             |
| Rulesets and playbooks                         | `CONFIG_DIR` / database        | In git                      | Versioned as code                                                                     |

## Method: logical backups with `pg_dump`

`pg_dump --format=custom` produces a compressed, consistent snapshot (one transaction,
MVCC: no need to stop the app) that `pg_restore` can restore fully, selectively or in
parallel. It is the right tool up to tens of GB. Beyond that, or if you need
point-in-time recovery (RPO of seconds), use physical backups with WAL archiving
(pgBackRest, or your managed Postgres's PITR).

**Targets for the single-host deployment:** RPO 24 h (nightly dump), RTO 30 min.

### Backup

```bash
# Compose. -T: no TTY, so the binary dump is not mangled.
docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
  pg_dump -U spine -d spine --format=custom --compress=6 --no-owner > spine-$(date -u +%Y%m%dT%H%M%SZ).dump
sha256sum spine-*.dump > SHA256SUMS
```

Store dumps **off the host** (object storage with versioning and a retention policy),
**encrypted** (e.g. `age -r <recipient> spine.dump > spine.dump.age`): a dump contains
password hashes and the audit log. Schedule it with a systemd timer or cron; alert if the
newest dump is older than 26 hours.

### Restore

Always restore into a **new** database first, check it, then switch.

```bash
dc() { docker compose -f infra/docker-compose.yml --env-file .env "$@"; }
dc exec -T postgres pg_restore --list < spine.dump | head           # archive readable?
dc exec -T postgres psql -U spine -d postgres -c 'CREATE DATABASE spine_restored;'
dc exec -T postgres pg_restore -U spine -d spine_restored --no-owner --exit-on-error < spine.dump
dc exec -T postgres psql -U spine -d postgres -c 'GRANT CONNECT ON DATABASE spine_restored TO spine_app;'
# Check, then point DATABASE_URL / POSTGRES_DB at spine_restored (or rename databases
# while the app is stopped) and `make up`.
```

**Roles aren't in the dump.** `pg_dump` saves the table GRANTs to `spine_runtime` (ADR-0092), but
roles are cluster-wide and aren't included. Restoring into the same cluster just works (tested on
2026-10-29: the runtime role reads the restored data and still can't update `audit_log`). On a
**new** cluster, run `CREATE ROLE spine_runtime NOLOGIN;` before `pg_restore` (otherwise
`--exit-on-error` stops at the first GRANT), then run the migrate step to recreate the login role.

After a restore, Redis may hold jobs for state that no longer exists, or miss jobs for
state that does: flush the queues and let the system rebuild them (worker restart →
reconciler; re-dispatch recent events as in the [Redis wiped](runbooks.md#redis-wiped)
runbook). Migrations recorded in `schema_migrations` come back with the dump, so the
migrator only applies those that are newer than the backup.

## Tested drill (2026-10-28, compose stack, Postgres 16)

A backup is only real once a restore has worked. This is the exact drill run while
writing this page, with its real output (the marker row proves data, not just schema,
came back):

```text
# 0. Some data to protect (a marker event, already dispatched so the relay ignores it)
$ docker compose exec -T postgres psql -U spine -d spine -v ON_ERROR_STOP=1 -c "INSERT INTO domain_events (event_id, type, aggregate_id, payload, dispatched_at) VALUES ('0190f2a0-0000-7000-8000-00000000bac0', 'backup.drill', 'drill', '{\"note\":\"restore me\"}', now());"
INSERT 0 1

# 1. Logical backup in custom format
$ docker compose exec -T postgres pg_dump -U spine -d spine --format=custom --compress=6 --no-owner > spine.dump
$ ls -l spine.dump
-rw-r--r-- 1 root root 34302 Oct 28 16:51 spine.dump
$ sha256sum spine.dump > spine.dump.sha256
6d322859ffd4cc346d67f9e7e137eb5b621a8fbe2e74546b4b6c430f13586083  spine.dump

# 2. Verify the archive is readable
$ docker compose exec -T postgres pg_restore --list < spine.dump | grep -c 'TABLE DATA'
15

# 3. Restore into a scratch database
$ docker compose exec -T postgres psql -U spine -d postgres -c 'CREATE DATABASE spine_restore_drill;'
CREATE DATABASE
$ docker compose exec -T postgres pg_restore -U spine -d spine_restore_drill --no-owner --exit-on-error < spine.dump
(exit 0)

# 4. Compare source and restore
$ psql -d spine               -c "SELECT (SELECT count(*) FROM schema_migrations) AS migrations, (SELECT count(*) FROM domain_events) AS events, (SELECT payload->>'note' FROM domain_events WHERE type='backup.drill') AS marker, (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') AS tables;"
 migrations | events |   marker   | tables
------------+--------+------------+--------
          7 |      1 | restore me |     15
$ psql -d spine_restore_drill -c "<same query>"
 migrations | events |   marker   | tables
------------+--------+------------+--------
          7 |      1 | restore me |     15

# 5. Clean up
$ psql -d postgres -c 'DROP DATABASE spine_restore_drill;'
DROP DATABASE
$ psql -d spine -c "DELETE FROM domain_events WHERE type='backup.drill';"
DELETE 1
```

Repeat the drill after every schema-heavy release and at least quarterly; time it, and
compare the time with the RTO.
