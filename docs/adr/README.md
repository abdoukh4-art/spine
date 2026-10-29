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

| #                                                                 | Title                                                                                        | Status   | Tags                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- | ---------------------- |
| [0001](0001-record-architecture-decisions.md)                     | Record architecture decisions as MADR files                                                  | accepted | process                |
| [0002](0002-hexagonal-modular-monolith.md)                        | Hexagonal modular monolith with bounded contexts                                             | accepted | architecture           |
| [0003](0003-typescript-node-pnpm-monorepo.md)                     | TypeScript (strict) on Node.js 22 LTS in a pnpm workspace monorepo                           | accepted | architecture, process  |
| [0004](0004-fastify-http-framework.md)                            | Fastify as the HTTP framework                                                                | accepted | architecture           |
| [0005](0005-zod-contracts-and-openapi.md)                         | Zod schemas are the single source of truth; OpenAPI is generated                             | accepted | architecture, data     |
| [0006](0006-kysely-and-plain-sql-migrations.md)                   | Kysely with plain SQL migrations                                                             | accepted | data                   |
| [0007](0007-postgresql-system-of-record.md)                       | PostgreSQL 16 as the single system of record                                                 | accepted | data                   |
| [0008](0008-bullmq-redis-job-queue.md)                            | BullMQ on Redis for playbook and pipeline jobs                                               | accepted | architecture           |
| [0009](0009-domain-events-transactional-outbox.md)                | Cross-module domain events via a transactional outbox                                        | accepted | architecture, data     |
| [0010](0010-event-sourcing-for-playbook-runs-only.md)             | Event sourcing only for playbook run history                                                 | accepted | architecture, data     |
| [0011](0011-canonical-alert-schema.md)                            | One canonical alert schema (ECS/OCSF-inspired) with MITRE ATT&CK mapping                     | accepted | data                   |
| [0012](0012-idempotency-and-deduplication.md)                     | Idempotency keys + fingerprint deduplication                                                 | accepted | data, architecture     |
| [0013](0013-playbook-dsl.md)                                      | Playbook DSL: declarative DAG with structured, non-eval conditions                           | accepted | architecture, security |
| [0014](0014-hand-written-resilience-primitives.md)                | Hand-written resilience primitives for enrichment                                            | accepted | architecture           |
| [0015](0015-explainable-rule-based-scoring.md)                    | Explainable, additive rule-based scoring with versioned rulesets                             | accepted | architecture           |
| [0016](0016-authentication-jwt-refresh-rotation.md)               | JWT access + rotating refresh tokens, argon2id, audit log                                    | accepted | security               |
| [0017](0017-rbac-model.md)                                        | RBAC with three hierarchical roles                                                           | accepted | security               |
| [0018](0018-simulated-response-adapters.md)                       | All response actions go through simulated adapters                                           | accepted | security, architecture |
| [0019](0019-observability-otel-pino-prometheus.md)                | OpenTelemetry, pino, Prometheus and Grafana                                                  | accepted | ops                    |
| [0020](0020-enforce-module-boundaries.md)                         | Enforce boundaries with dependency-cruiser                                                   | accepted | architecture, process  |
| [0021](0021-testing-strategy.md)                                  | Testing pyramid: Vitest, fast-check, Testcontainers, contract tests, Playwright              | accepted | testing                |
| [0022](0022-dependency-pinning-and-version-policy.md)             | Pin exact versions; prefer mature releases                                                   | accepted | security, process      |
| [0023](0023-console-react-vite-no-ui-kit.md)                      | Console: React + Vite, hand-built accessible components                                      | accepted | frontend               |
| [0024](0024-api-conventions.md)                                   | API conventions: versioning, problem details, cursors, rate limits, headers                  | accepted | architecture, security |
| [0025](0025-git-workflow-and-ci-gates.md)                         | Git workflow and required CI gates                                                           | accepted | process                |
| [0026](0026-mttd-mttr-definitions.md)                             | Precise definitions of MTTD, MTTR and playbook success rate                                  | accepted | data                   |
| [0027](0027-workspace-packages-as-source-and-esbuild-bundling.md) | Consume workspace packages as TS source; bundle the API with esbuild                         | accepted | architecture, process  |
| [0028](0028-security-patches-override-version-maturity.md)        | Security patches override the "mature version" rule (amends 0022)                            | accepted | security, process      |
| [0029](0029-metrics-read-side-module-and-cached-gauges.md)        | Metrics is a read-side module; SOC gauges refreshed off the scrape path                      | accepted | architecture, ops      |
| [0030](0030-pure-normalizers-and-preparation-pipeline.md)         | Pure normalizers returning a typed Result; no `generic` normalizer                           | accepted | architecture, data     |
| [0031](0031-source-mapping-rules-suricata-and-cef.md)             | Mapping rules for Suricata EVE and CEF sources                                               | accepted | data                   |
| [0032](0032-indicator-normalization.md)                           | Indicator extraction and normalization rules                                                 | accepted | data                   |
| [0033](0033-ingest-transaction-race-and-idempotency.md)           | One ingest transaction; retry the whole unit after losing a race                             | accepted | data, architecture     |
| [0034](0034-ingest-backpressure-implementation.md)                | Back-pressure checks a cached outbox backlog in `onRequest`                                  | accepted | architecture, ops      |
| [0035](0035-webhook-authentication-details.md)                    | Webhook authentication: HMAC over the raw body in an encapsulated route scope                | accepted | security               |
| [0036](0036-alert-lifecycle-resolved-at.md)                       | `resolvedAt` is the first close, never moved; same-status updates are no-ops                 | accepted | data                   |
| [0037](0037-alert-queue-query-semantics.md)                       | Alert queue queries: NULLS LAST cursors, effective severity, parent techniques               | accepted | data, architecture     |
| [0038](0038-score-projection-ordering-guard.md)                   | The score projection ignores scores older than the one already applied                       | accepted | data, architecture     |
| [0040](0040-enrichment-idempotent-receiver.md)                    | The enrichment handler is an idempotent receiver keyed by event id                           | accepted | architecture, data     |
| [0041](0041-enrichment-merge-keeps-last-success.md)               | Stored enrichment keeps the last success; events carry the merged view                       | accepted | data                   |
| [0042](0042-scoring-publish-only-on-change.md)                    | Scoring is idempotent per (alert, ruleset) and publishes only on change                      | accepted | architecture, data     |
| [0043](0043-scoring-evaluation-context.md)                        | Scoring rules see a summarized evaluation context, not raw results                           | accepted | architecture           |
| [0044](0044-resilience-defaults-and-breaker-semantics.md)         | Resilience defaults and circuit-breaker semantics                                            | accepted | architecture, ops      |
| [0045](0045-deterministic-mock-providers.md)                      | Fixture-driven mock providers with seeded fault injection                                    | accepted | testing, architecture  |
| [0046](0046-ruleset-loaded-once-fail-fast.md)                     | Load the scoring ruleset once at startup and fail fast if invalid                            | accepted | architecture, ops      |
| [0050](0050-playbook-engine-reduce-decide-act.md)                 | Playbook engine as reduce → decide → act, with attempt-scoped idempotency keys               | accepted | architecture           |
| [0051](0051-executor-hosting-on-bullmq.md)                        | Hosting the executor on BullMQ: one job = one advance, timers as delayed jobs                | accepted | architecture, ops      |
| [0052](0052-run-lifecycle-dry-run-cancel-timeout.md)              | Run lifecycle semantics: dry-run, cancellation, approval timeouts                            | accepted | architecture, security |
| [0053](0053-run-snapshot-and-evaluation-context.md)               | Runs carry an alert snapshot; conditions see an enrichment summary                           | accepted | architecture, data     |
| [0054](0054-locked-down-playbook-source-parsing.md)               | Locked-down YAML/JSON parsing for playbook sources                                           | accepted | security               |
| [0055](0055-run-projection-and-outbox-in-append-transaction.md)   | Rebuild the run projection and emit domain events inside every append                        | accepted | data, architecture     |
| [0060](0060-authenticator-reloads-user-with-short-cache.md)       | Authenticator reloads the user per request (≤ 30 s cache)                                    | accepted | security, architecture |
| [0061](0061-csrf-origin-required-in-every-environment.md)         | CSRF: custom header + allow-listed Origin in every environment                               | accepted | security               |
| [0062](0062-strict-refresh-rotation-under-row-lock.md)            | Strict refresh rotation under a row lock, no grace window                                    | accepted | security, data         |
| [0063](0063-two-dimensional-login-throttle.md)                    | Two-dimensional login throttle (Redis fixed window, in-memory fallback)                      | accepted | security, architecture |
| [0064](0064-audit-log-write-policy.md)                            | Audit write policy: best-effort HTTP trail, no bodies, hashed emails                         | accepted | security, data         |
| [0065](0065-last-active-admin-protection.md)                      | Always keep at least one active admin                                                        | accepted | security, data         |
| [0066](0066-first-run-admin-bootstrap.md)                         | First-run admin bootstrap from env, only on an empty users table                             | accepted | security, ops          |
| [0067](0067-authorize-before-body-parsing.md)                     | Authorize in onRequest and attribute forbidden requests                                      | accepted | security, architecture |
| [0070](0070-console-api-client-validation-and-refresh.md)         | Console API client: validate every response, single-flight token refresh                     | accepted | frontend, security     |
| [0071](0071-console-in-browser-fake-api.md)                       | In-browser typed fake API for console tests and the standalone demo                          | accepted | frontend, testing      |
| [0072](0072-console-plain-css-with-prefixed-classes.md)           | Console styling: one plain-CSS file, `sp-` classes, design tokens                            | accepted | frontend               |
| [0073](0073-console-hand-built-svg-charts.md)                     | Hand-built accessible SVG bar charts, no chart library                                       | accepted | frontend               |
| [0074](0074-console-data-freshness-and-optimistic-updates.md)     | Console freshness: polling, URL filters, optimistic approvals with rollback                  | accepted | frontend, architecture |
| [0080](0080-telemetry-bootstrap-and-metric-conventions.md)        | Telemetry bootstrap: NodeSDK preload, Prometheus pull, optional OTLP, verified metric naming | accepted | ops                    |
| [0081](0081-container-images-distroless-single-image.md)          | Container images: one distroless non-root image for API and worker                           | accepted | ops, security          |
| [0082](0082-nginx-edge-proxy.md)                                  | nginx as the edge: SPA hosting, reverse proxy, TLS termination                               | accepted | ops, security          |
| [0083](0083-single-host-deployment-compose-and-systemd.md)        | Single-host deployment: hardened Docker Compose, systemd units as the alternative            | accepted | ops, security          |
| [0084](0084-slos-and-burn-rate-alerting.md)                       | SLOs with multi-window, multi-burn-rate alerting                                             | accepted | ops                    |
| [0085](0085-image-scanning-and-sbom-in-ci.md)                     | Scan container images with Trivy and publish image SBOMs in CI                               | accepted | security, process      |
| [0090](0090-load-test-fixes-retention-fail-open-poll-interval.md) | Bounded job retention, fail-open rate limiting, 50 ms outbox poll (from the first load test) | accepted | ops, architecture      |
| [0092](0092-separate-migration-and-runtime-database-roles.md)     | Separate migration (owner) and runtime database roles                                        | accepted | security, ops          |
