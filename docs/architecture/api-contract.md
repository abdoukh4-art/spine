# API contract (v1)

> The **normative** contract is the Zod code in [`packages/shared-schema`](../../packages/shared-schema)
> and the generated [`openapi.json`](openapi.json) ([ADR-0005](../adr/0005-zod-contracts-and-openapi.md)).
> This page is the human-readable design: what each endpoint is _for_, who may call it,
> and how it behaves at the edges. If this page and the code disagree, the code wins, and
> this page has a bug. Please fix it in the same PR.

Conventions ([ADR-0024](../adr/0024-api-conventions.md)): base path `/api/v1`, camelCase
JSON, ISO-8601 UTC timestamps, UUIDv7 IDs, RFC 9457 errors (`application/problem+json`),
cursor pagination `{ items, nextCursor }`.

Auth column: `—` = public, `V` = viewer+, `A` = analyst+, `Ad` = admin only,
`HMAC` = webhook signature ([ADR-0017](../adr/0017-rbac-model.md)).

## Platform

| Method | Path                   | Auth | Purpose                                                                                                                                                                                         |
| ------ | ---------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`             | —    | Liveness: `200 {status:"ok"}` while the process can serve.                                                                                                                                      |
| GET    | `/readyz`              | —    | Readiness: `200` when DB and Redis are reachable, migrations are applied and ingest backlog < threshold. Otherwise `503 {status:"not_ready", checks:{…}}` with check names only (no internals). |
| GET    | `/api/v1/openapi.json` | —    | The OpenAPI 3.1 document. Swagger UI at `/docs` in non-production only.                                                                                                                         |

## Auth & users (module: auth)

| Method | Path                   | Auth                                              | Request                                | Response                                                                                                  |
| ------ | ---------------------- | ------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/auth/login`   | — (rate limited)                                  | `{email, password}`                    | `200 {accessToken, expiresIn, user}` + `Set-Cookie: spine_refresh`                                        |
| POST   | `/api/v1/auth/refresh` | refresh cookie + `X-Spine-CSRF: 1` + Origin check | —                                      | `200 {accessToken, expiresIn, user}` + rotated cookie. A reused token gives `401` and revokes the family. |
| POST   | `/api/v1/auth/logout`  | refresh cookie + CSRF header                      | —                                      | `204`, revokes the token family, clears the cookie                                                        |
| GET    | `/api/v1/auth/me`      | V                                                 | —                                      | `200 User`                                                                                                |
| GET    | `/api/v1/users`        | Ad                                                | `?cursor&limit`                        | `Page<User>`                                                                                              |
| POST   | `/api/v1/users`        | Ad                                                | `{email, displayName, role, password}` | `201 User`                                                                                                |
| PATCH  | `/api/v1/users/:id`    | Ad                                                | `{role?, disabled?, displayName?}`     | `200 User`                                                                                                |
| GET    | `/api/v1/audit-log`    | Ad                                                | `?actorId&action&from&to&cursor&limit` | `Page<AuditEntry>`                                                                                        |

`User = {id, email, displayName, role: viewer|analyst|admin, disabled, createdAt, lastLoginAt|null}`. The password hash is **never** serialized (the response schema excludes it).

## Ingestion (module: ingestion)

| Method | Path                                                    | Auth                                                                                                     | Request                                                                        | Response                                                                                                                          |
| ------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/alerts`                                        | A                                                                                                        | `CanonicalAlertInput`; optional `Idempotency-Key` header                       | `202 {alertId, status:"created"\|"deduplicated", duplicateOf?}`                                                                   |
| POST   | `/api/v1/ingest/webhooks/:sourceId`                     | HMAC (`X-Spine-Timestamp`, `X-Spine-Signature: sha256=<hex>` over `timestamp + "." + body`, ±5 min skew) | source-specific JSON (the source's configured normalizer, e.g. `suricata-eve`) | `202 IngestResult`; `401` on a bad signature                                                                                      |
| POST   | `/api/v1/ingest/batch?format=ndjson\|cef\|suricata-eve` | A                                                                                                        | `text/plain` or `application/x-ndjson` body ≤ 10 MiB, one record per line      | `200 {accepted, deduplicated, rejected, errors:[{line, message}]}` (partial success is allowed, and per-line errors are reported) |

Back-pressure: all ingestion endpoints return `503` + `Retry-After` when the outbox backlog
exceeds `INGEST_MAX_BACKLOG`. Idempotency-Key reuse with a different body returns `409`.

## Alerts & cases (module: alerts)

| Method | Path                 | Auth | Request                                                                                                                     | Response                                                                                          |
| ------ | -------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------- |
| GET    | `/api/v1/alerts`     | V    | `?status&severity&minScore&maxScore&category&source&q&from&to&assignee&sort=receivedAt\|score&order=desc\|asc&cursor&limit` | `Page<AlertSummary>`                                                                              |
| GET    | `/api/v1/alerts/:id` | V    | —                                                                                                                           | `AlertDetail` = alert + `enrichments[]` + `score` (ScoreExplanation\|null) + `runs[]` (summaries) |
| PATCH  | `/api/v1/alerts/:id` | A    | `{status?, assigneeId?                                                                                                      | null, caseId?                                                                                     | null}`; status transitions validated | `200 AlertSummary`; `409` on an illegal transition |
| GET    | `/api/v1/cases`      | V    | `?status&cursor&limit`                                                                                                      | `Page<Case>`                                                                                      |
| POST   | `/api/v1/cases`      | A    | `{title, description?, alertIds[]}`                                                                                         | `201 Case`                                                                                        |
| GET    | `/api/v1/cases/:id`  | V    | —                                                                                                                           | `Case` + linked alerts                                                                            |
| PATCH  | `/api/v1/cases/:id`  | A    | `{status?, title?, description?, addAlertIds?, removeAlertIds?}`                                                            | `200 Case`                                                                                        |

Alert status machine: `new → triaged → in_progress → resolved | false_positive`. Any open
state may go directly to `resolved` or `false_positive`. Closed alerts may be **reopened** to `in_progress`.

## Enrichment & scoring (modules: enrichment, scoring)

| Method | Path                           | Auth | Purpose                                                                                                                                                                                                                                      |
| ------ | ------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/alerts/:id/enrich`    | A    | Re-run enrichment (e.g. after a provider outage). `202 {alertId, enrichments}`: the alert's **merged** stored results ([ADR-0041](../adr/0041-enrichment-merge-keeps-last-success.md)); re-scoring follows asynchronously. `404` if unknown. |
| GET    | `/api/v1/enrichment/providers` | V    | `ProviderStatus[]` = `{name, supports[], circuit: closed\|open\|half_open, inFlight, queued}`. State is per process (this is the API process's view, [ADR-0044](../adr/0044-resilience-defaults-and-breaker-semantics.md)).                  |
| GET    | `/api/v1/scoring/ruleset`      | V    | The active ruleset (`version`, `baseline`, `rules[]`) for transparency.                                                                                                                                                                      |
| POST   | `/api/v1/scoring/preview`      | A    | `{alert: Alert \| CanonicalAlertInput, enrichments?: EnrichmentResult[]}` → `200 ScoreExplanation`, nothing persisted. Useful for authoring rules.                                                                                           |

## Playbooks (module: playbooks)

| Method | Path                             | Auth | Request                                                     | Response                                                                                    |
| ------ | -------------------------------- | ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/playbooks`              | V    | —                                                           | `PlaybookSummary[]` (latest version of each, with `enabled`)                                |
| GET    | `/api/v1/playbooks/:id`          | V    | `?version`                                                  | `PlaybookRecord` (definition + metadata)                                                    |
| POST   | `/api/v1/playbooks/validate`     | A    | `{source: string, format: yaml\|json}`                      | `200 {valid: true, definition}` or `422 problem` with `errors[]` (path + message)           |
| POST   | `/api/v1/playbooks`              | Ad   | `{source, format}`                                          | `201 PlaybookRecord` (new immutable version)                                                |
| PATCH  | `/api/v1/playbooks/:id`          | Ad   | `{enabled}`                                                 | `200 PlaybookSummary`                                                                       |
| POST   | `/api/v1/playbooks/:id/runs`     | A    | `{alertId, dryRun?: boolean}`                               | `202 {runId}`                                                                               |
| GET    | `/api/v1/runs`                   | V    | `?playbookId&alertId&status&cursor&limit`                   | `Page<RunSummary>`                                                                          |
| GET    | `/api/v1/runs/:id`               | V    | —                                                           | `RunDetail` = summary + `events[]` (the full timeline) + `steps[]` (derived per-step state) |
| POST   | `/api/v1/runs/:id/cancel`        | A    | —                                                           | `202`                                                                                       |
| GET    | `/api/v1/approvals`              | V    | `?status=pending\|approved\|rejected\|expired&cursor&limit` | `Page<Approval>`                                                                            |
| POST   | `/api/v1/approvals/:id/decision` | A    | `{decision: approve\|reject, comment?}`                     | `200 Approval`; `409` if already decided or expired                                         |
| GET    | `/api/v1/simulated-actions`      | V    | `?kind&cursor&limit`                                        | `Page<SimulatedAction>` (what the mock firewall/ticketing/chat "did")                       |

## Metrics (module: metrics)

| Method | Path                      | Auth | Request                           | Response                                                                                                                                     |
| ------ | ------------------------- | ---- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/metrics/summary` | V    | `?from&to` (default: last 7 days) | `{window, alertVolume:{total, bySeverity, byDay[]}, mttd: Stat, mttr: Stat & {openCount}, playbooks:{successRate, runs:{…}, latency: Stat}}` |

`Stat = {count, meanSeconds|null, p50Seconds|null, p90Seconds|null}`. Definitions: [ADR-0026](../adr/0026-mttd-mttr-definitions.md).

## Error catalogue (problem `type` slugs)

| Slug                     | Status | When                                                                           |
| ------------------------ | ------ | ------------------------------------------------------------------------------ |
| `validation-error`       | 400    | Body, query or params fail the schema (`errors[]` lists paths)                 |
| `unauthenticated`        | 401    | Missing, invalid or expired token                                              |
| `forbidden`              | 403    | Authenticated but the role is insufficient                                     |
| `not-found`              | 404    | Unknown resource (also used instead of 403 when existence itself is sensitive) |
| `conflict`               | 409    | Illegal state transition, approval already decided                             |
| `idempotency-key-reused` | 409    | Same key, different body                                                       |
| `playbook-invalid`       | 422    | DSL validation failed                                                          |
| `rate-limited`           | 429    | Too many requests (`Retry-After`)                                              |
| `overloaded`             | 503    | Ingestion back-pressure (`Retry-After`)                                        |
| `internal`               | 500    | Unexpected. Body contains only the `instance` request ID for log lookup        |
