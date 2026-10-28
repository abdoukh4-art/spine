# ADR-0006: Kysely query builder with plain SQL migrations (not Drizzle, not Prisma)

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** data

## Context and problem statement

Adapters need type-safe access to PostgreSQL. The mission allowed "Drizzle ORM or
Kysely". Persistence code must stay inside adapters, and domain objects must **not** be
ORM entities (a hexagonal anti-pattern: _domain as ORM entity_).

## Decision drivers

- Type-safe SQL without the ORM owning our domain model.
- Migrations a reviewer (and a DBA) can read as **plain SQL**, including Postgres-specific
  features: `jsonb`, partial indexes, `GIN`, `FOR UPDATE SKIP LOCKED`.
- Easy transactions that span a repository write and an outbox insert ([ADR-0009](0009-domain-events-transactional-outbox.md)).
- Low magic for learners.

## Considered options

1. **Kysely + plain `.sql` migration files + a tiny in-repo migration runner**
2. Drizzle ORM + drizzle-kit generated migrations
3. Prisma
4. Raw `pg` with hand-written SQL strings

## Decision outcome

**Chosen option 1.**

- `apps/api/migrations/NNNN_<module>_<desc>.sql` are applied in lexical order by
  `platform/db/migrator.ts`. The migrator records each file and its SHA-256 checksum in
  `schema_migrations`, refuses to run if an applied file was modified, and wraps each file
  in a transaction. Number ranges are reserved per module to avoid merge conflicts:
  `0001–0099` platform, `0100` auth, `0200` alerts/cases, `0300` ingestion,
  `0400` enrichment, `0500` scoring, `0600` playbooks, `0700` metrics.
- The Kysely `Database` interface (row types) lives in `platform/db/schema.ts` and is
  written by hand next to the migration that creates each table. A test checks that the
  live schema has every column the interface declares.
- Migrations are **forward-only**. Rollback = a new migration (see
  [operations/upgrade.md](../operations/upgrade.md)).

### Consequences

- 👍 SQL is visible and reviewable. Kysely compiles to exactly the SQL you would write.
- 👍 Transactions are explicit: `db.transaction().execute(async (trx) => …)`.
- 👎 Row types are maintained by hand. Mitigated by the schema-drift test.
- 👎 There is no "generate a migration from a model diff". Writing DDL by hand is the point.

## Pros and cons of the options

### Drizzle

- 👍 Good TS DX, and schema-as-code generates migrations.
- 👎 The schema-in-TS becomes the source of truth for tables, which tempts developers to
  use table objects as domain entities. Generated migrations hide the DDL from the reviewer.

### Prisma

- 👍 Mature, great tooling.
- 👎 A separate schema language and a heavy engine. Raw Postgres features (SKIP LOCKED,
  partial indexes) are second-class. Its model types leak into domain code easily.

### Raw `pg`

- 👍 Zero abstraction.
- 👎 No type safety on columns, and it's easy to make SQL-injection mistakes with string building.

## What would make us revisit this

- Kysely stops being maintained.
- Hand-maintained row types cause more than two production bugs. Then adopt
  `kysely-codegen` from the live schema.

## Further reading

- Kysely docs, _Getting started_ and _Transactions_
- Martin Fowler, _Evolutionary Database Design_
