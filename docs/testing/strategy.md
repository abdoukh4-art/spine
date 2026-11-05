# Testing strategy

Decision record: [ADR-0021](../adr/0021-testing-strategy.md). This page is the practical guide.

## The pyramid in Spine

| Layer           | Command                 | Needs                                                | Where tests live                                                                                       |
| --------------- | ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Unit + property | `pnpm test`             | nothing                                              | `packages/*/test`, `apps/api/test/unit`, `apps/api/src/**/*.test.ts`, `apps/console/src/**/*.test.tsx` |
| Integration     | `pnpm test:integration` | Docker **or** `TEST_DATABASE_URL` + `TEST_REDIS_URL` | `apps/api/test/integration`                                                                            |
| Contract        | part of integration     | —                                                    | `apps/api/test/integration/contract.test.ts`                                                           |
| End-to-end      | `pnpm test:e2e`         | running stack (`make up`)                            | `e2e/`                                                                                                 |
| Load            | `make load-test`        | running stack + k6                                   | `load/`                                                                                                |

## Running integration tests without Docker

```bash
export TEST_DATABASE_URL=postgres://spine:spine@localhost:5432/spine_test
export TEST_REDIS_URL=redis://localhost:6379/15
pnpm test:integration
```

Each test **file** creates its own Postgres schema (`test_<random>`), runs all migrations
into it and drops it afterwards (`apps/api/test/support/db.ts`). Files can run in parallel
against one server, and a failed run leaves no shared state behind.

## Conventions

- Name tests by behaviour: `it('rejects a playbook whose graph has a cycle')`.
- Arrange / Act / Assert, with one behaviour per test.
- **No sleeps.** Inject a `Clock` (`ManualClock`) and use fake timers. For async
  eventual-consistency checks use `expect.poll` with a timeout.
- Property tests (`fast-check`) state an invariant in the test name, and fast-check
  prints the failing seed on failure. Re-run it with `fc.assert(prop, { seed, path })`.
- Fixtures live next to the code that owns them (`fixtures/` folders) and are realistic but synthetic.
- Coverage gates: ≥ 85 % on `packages/playbook-engine`, `packages/enrichers`,
  `packages/shared-schema` and `apps/api/src/modules/*/domain` (unit tests alone); ≥ 90 % lines and
  ≥ 80 % branches for the whole API measured over unit + integration tests
  (`pnpm --filter @spine/api test:coverage:all`, [ADR-0091](../adr/0091-combined-unit-and-integration-coverage.md)).

## What we deliberately don't test

- Third-party library internals (Fastify routing, Kysely SQL generation).
- Private helpers. Test them through the public function that uses them.
- Exact log output, except secret redaction.
