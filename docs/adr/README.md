# Architecture Decision Records

Every meaningful decision in Spine, big or small, is written down here in the
[MADR](https://adr.github.io/madr/) format ([ADR-0001](0001-record-architecture-decisions.md)).
Each ADR states the context, the options considered (rejected ones included), the trade-offs,
the decision, its consequences, and **what would make us revisit it**.

New ADR: copy [template.md](template.md), take the next number, and add a row below
in the same PR. CI checks that every ADR file appears in this index.

**How to read these as a learner:** start with 0002 (overall shape), then 0009 + 0010
(how data flows and is remembered), then 0013 + 0015 (the two engines), then 0016 + 0017
(security). Each one ends with further reading.

| #                                                                 | Title                                                                           | Status   | Tags                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- | ---------------------- |
| [0001](0001-record-architecture-decisions.md)                     | Record architecture decisions as MADR files                                     | accepted | process                |
| [0002](0002-hexagonal-modular-monolith.md)                        | Hexagonal modular monolith with bounded contexts                                | accepted | architecture           |
| [0003](0003-typescript-node-pnpm-monorepo.md)                     | TypeScript (strict) on Node.js 22 LTS in a pnpm workspace monorepo              | accepted | architecture, process  |
| [0004](0004-fastify-http-framework.md)                            | Fastify as the HTTP framework                                                   | accepted | architecture           |
| [0005](0005-zod-contracts-and-openapi.md)                         | Zod schemas are the single source of truth; OpenAPI is generated                | accepted | architecture, data     |
| [0006](0006-kysely-and-plain-sql-migrations.md)                   | Kysely with plain SQL migrations                                                | accepted | data                   |
| [0007](0007-postgresql-system-of-record.md)                       | PostgreSQL 16 as the single system of record                                    | accepted | data                   |
| [0008](0008-bullmq-redis-job-queue.md)                            | BullMQ on Redis for playbook and pipeline jobs                                  | accepted | architecture           |
| [0009](0009-domain-events-transactional-outbox.md)                | Cross-module domain events via a transactional outbox                           | accepted | architecture, data     |
| [0010](0010-event-sourcing-for-playbook-runs-only.md)             | Event sourcing only for playbook run history                                    | accepted | architecture, data     |
| [0011](0011-canonical-alert-schema.md)                            | One canonical alert schema (ECS/OCSF-inspired) with MITRE ATT&CK mapping        | accepted | data                   |
| [0012](0012-idempotency-and-deduplication.md)                     | Idempotency keys + fingerprint deduplication                                    | accepted | data, architecture     |
| [0013](0013-playbook-dsl.md)                                      | Playbook DSL: declarative DAG with structured, non-eval conditions              | accepted | architecture, security |
| [0014](0014-hand-written-resilience-primitives.md)                | Hand-written resilience primitives for enrichment                               | accepted | architecture           |
| [0015](0015-explainable-rule-based-scoring.md)                    | Explainable, additive rule-based scoring with versioned rulesets                | accepted | architecture           |
| [0016](0016-authentication-jwt-refresh-rotation.md)               | JWT access + rotating refresh tokens, argon2id, audit log                       | accepted | security               |
| [0017](0017-rbac-model.md)                                        | RBAC with three hierarchical roles                                              | accepted | security               |
| [0018](0018-simulated-response-adapters.md)                       | All response actions go through simulated adapters                              | accepted | security, architecture |
| [0019](0019-observability-otel-pino-prometheus.md)                | OpenTelemetry, pino, Prometheus and Grafana                                     | accepted | ops                    |
| [0020](0020-enforce-module-boundaries.md)                         | Enforce boundaries with dependency-cruiser                                      | accepted | architecture, process  |
| [0021](0021-testing-strategy.md)                                  | Testing pyramid: Vitest, fast-check, Testcontainers, contract tests, Playwright | accepted | testing                |
| [0022](0022-dependency-pinning-and-version-policy.md)             | Pin exact versions; prefer mature releases                                      | accepted | security, process      |
| [0023](0023-console-react-vite-no-ui-kit.md)                      | Console: React + Vite, hand-built accessible components                         | accepted | frontend               |
| [0024](0024-api-conventions.md)                                   | API conventions: versioning, problem details, cursors, rate limits, headers     | accepted | architecture, security |
| [0025](0025-git-workflow-and-ci-gates.md)                         | Git workflow and required CI gates                                              | accepted | process                |
| [0026](0026-mttd-mttr-definitions.md)                             | Precise definitions of MTTD, MTTR and playbook success rate                     | accepted | data                   |
| [0027](0027-workspace-packages-as-source-and-esbuild-bundling.md) | Consume workspace packages as TS source; bundle the API with esbuild            | accepted | architecture, process  |
| [0028](0028-security-patches-override-version-maturity.md)        | Security patches override the "mature version" rule (amends 0022)               | accepted | security, process      |
| [0050](0050-playbook-engine-reduce-decide-act.md)                 | Playbook engine as reduce → decide → act, with attempt-scoped idempotency keys  | accepted | architecture           |
| [0051](0051-executor-hosting-on-bullmq.md)                        | Hosting the executor on BullMQ: one job = one advance, timers as delayed jobs   | accepted | architecture, ops      |
| [0052](0052-run-lifecycle-dry-run-cancel-timeout.md)              | Run lifecycle semantics: dry-run, cancellation, approval timeouts               | accepted | architecture, security |
| [0053](0053-run-snapshot-and-evaluation-context.md)               | Runs carry an alert snapshot; conditions see an enrichment summary              | accepted | architecture, data     |
| [0054](0054-locked-down-playbook-source-parsing.md)               | Locked-down YAML/JSON parsing for playbook sources                              | accepted | security               |
| [0055](0055-run-projection-and-outbox-in-append-transaction.md)   | Rebuild the run projection and emit domain events inside every append           | accepted | data, architecture     |
| [0060](0060-authenticator-reloads-user-with-short-cache.md)       | Authenticator reloads the user per request (≤ 30 s cache)                       | accepted | security, architecture |
| [0061](0061-csrf-origin-required-in-every-environment.md)         | CSRF: custom header + allow-listed Origin in every environment                  | accepted | security               |
| [0062](0062-strict-refresh-rotation-under-row-lock.md)            | Strict refresh rotation under a row lock, no grace window                       | accepted | security, data         |
| [0063](0063-two-dimensional-login-throttle.md)                    | Two-dimensional login throttle (Redis fixed window, in-memory fallback)         | accepted | security, architecture |
| [0064](0064-audit-log-write-policy.md)                            | Audit write policy: best-effort HTTP trail, no bodies, hashed emails            | accepted | security, data         |
| [0065](0065-last-active-admin-protection.md)                      | Always keep at least one active admin                                           | accepted | security, data         |
| [0066](0066-first-run-admin-bootstrap.md)                         | First-run admin bootstrap from env, only on an empty users table                | accepted | security, ops          |
| [0067](0067-authorize-before-body-parsing.md)                     | Authorize in onRequest and attribute forbidden requests                         | accepted | security, architecture |
