# ADR-0021: Testing pyramid with Vitest, fast-check, Testcontainers, OpenAPI contract tests and Playwright

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** testing

## Context and problem statement

Spine has pure logic (normalizers, scoring, playbook engine, resilience primitives),
persistence and queue adapters, an HTTP contract, and a UI. Each needs a different kind of
test, at a cost proportional to the confidence it buys.

## Decision drivers

- Fast feedback: most tests run in milliseconds without Docker.
- Real infrastructure where it matters (SQL, `SKIP LOCKED`, BullMQ semantics); mocks of Postgres lie.
- Edge cases humans don't think of → property-based testing for the engines.
- The API must not drift from the published OpenAPI.

## Considered options

1. **Vitest (unit + integration) + fast-check + Testcontainers + OpenAPI response validation + Playwright**
2. Jest + Supertest + Cypress
3. Only end-to-end tests

## Decision outcome

**Chosen option 1.**

| Layer       | Tool                                           | Scope                                                                                         | Runs                                |
| ----------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------- |
| Unit        | Vitest                                         | domain, application (with in-memory fakes), packages                                          | every commit, < 30 s                |
| Property    | fast-check in Vitest                           | scoring invariants, predicate interpreter, DAG validation, run reducer, resilience primitives | every commit                        |
| Integration | Vitest + Testcontainers (Postgres 16, Redis 7) | repositories, migrator, outbox relay, BullMQ workers, HTTP routes via `app.inject`            | every PR                            |
| Contract    | Vitest + Ajv against generated `openapi.json`  | every documented route: real responses validated against the spec                             | every PR                            |
| E2E         | Playwright (Chromium) + axe-core               | login → queue → alert detail → approve → run timeline                                         | every PR (compose stack)            |
| Load        | k6                                             | ingestion throughput / latency                                                                | manually + nightly, results in docs |

**Testcontainers fallback:** if `TEST_DATABASE_URL` / `TEST_REDIS_URL` are set, the
integration harness uses those servers instead of starting containers (CI service
containers or a developer's local instance). That keeps integration tests runnable where
Docker-in-Docker is unavailable, and it's documented in [testing/strategy.md](../testing/strategy.md).
Each test file gets an isolated schema (`CREATE SCHEMA test_<random>`) so files can run in parallel.

**Coverage gates** (`vitest --coverage`, v8): ≥ 85 % lines/branches for
`packages/playbook-engine`, `packages/enrichers`, `packages/shared-schema` and
`apps/api/src/modules/*/domain`. ≥ 70 % for the whole API. CI fails below the threshold.

**Conventions:** test names state behaviour ("rejects a playbook whose graph has a cycle"),
Arrange-Act-Assert, no sleeping in tests (fake timers and injectable clocks), fixtures in
`fixtures/` folders, and a property test always prints its seed on failure.

### Consequences

- 👍 Most confidence per CI minute. Real-DB tests catch SQL and locking bugs.
- 👎 Docker is needed for full local integration runs (or a local Postgres/Redis via env).
- 👎 Property tests occasionally need careful generators to avoid vacuous passes.

## Pros and cons of the options

### Jest + Cypress

- 👍 Popular.
- 👎 Jest ESM/TS support is clunkier than Vitest's. Cypress is slower and single-browser-tab oriented.

### E2E only

- 👎 Slow, flaky, and poor at locating failures. The inverted "ice-cream cone" anti-pattern.

## What would make us revisit this

- Integration suite > 5 min → shard across CI jobs.
- Flaky E2E rate > 2 % → quarantine plus root-cause each one (see [journal](../journal/README.md)).

## Further reading

- Mike Cohn, _Succeeding with Agile_ (the test pyramid)
- Google Testing Blog, _Test Sizes_; _Software Engineering at Google_, ch. 11–14
- John Hughes, _QuickCheck testing for fun and profit_ (property-based testing)
