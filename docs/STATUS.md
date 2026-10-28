# Project status

> Updated after every milestone. **Honest by rule:** anything not proven by a test or a
> recorded run is listed as unverified.

_Last updated: 2026-10-28 — end of Phase 0._

## Phase overview

| Phase | Scope                                                                                                      | State             |
| ----- | ---------------------------------------------------------------------------------------------------------- | ----------------- |
| 0     | Vision, ADRs, contracts, monorepo skeleton, CI, docs hub                                                   | ✅ done (this PR) |
| 1     | Ingestion+schema · Enrichment+scoring · Playbook engine · Auth+audit · Console shell · Infra+observability | ⏳ next           |
| 2     | Integration, console features, metrics, e2e, demo                                                          | ⏳                |
| 3     | Security review, performance, docs completeness, final README                                              | ⏳                |

## Done (verified)

- Founding docs: vision, domain primer, 27 ADRs, API contract, ERD, event catalog, threat model v1.
- `@spine/shared-schema`: all contract schemas + predicate interpreter. 61 tests (incl. property tests) passing.
- API platform: config, logging with redaction, problem+json errors, deny-by-default access
  control, security headers, CORS, rate limiting, health/readiness, OpenAPI, migrator,
  transactional outbox + relay, BullMQ delivery, graceful shutdown. 24 unit + 8 integration
  tests passing (Testcontainers Postgres 16 + Redis 7).
- SQL migrations for every bounded context (tables only; behaviour comes in Phase 1).
- Console scaffold builds and passes its test.

## Stubbed / not started

- All business modules (registered but empty).
- `packages/playbook-engine`, `packages/enrichers`.
- Infra (Docker, compose, nginx, Grafana), telemetry SDK bootstrap, demo, e2e, load tests.
- Tutorials and module guides (placeholders).

## Known issues

- Docker Hub rate-limits anonymous pulls in the build environment; images are pulled from
  `mirror.gcr.io` and re-tagged locally. CI uses GitHub's runners and is unaffected.
