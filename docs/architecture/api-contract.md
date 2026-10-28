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

Auth details (see [modules/auth.md](../modules/auth.md)):

- `POST /auth/login`: every failure (unknown email, wrong password, disabled account) is
  `401` with detail `invalid credentials`. More than `AUTH_LOGIN_MAX_PER_MINUTE` (10)
  attempts per minute per client IP **or** per normalized email give `429 rate-limited`
  with `Retry-After`. Token responses carry `Cache-Control: no-store`.
- `POST /auth/refresh` and `/auth/logout`: `403 forbidden` (`CSRF check failed`) unless
  `X-Spine-CSRF: 1` is present **and** `Origin` is exactly one of `CORS_ALLOWED_ORIGINS`
  (a missing Origin is rejected in every environment, [ADR-0061](../adr/0061-csrf-origin-required-in-every-environment.md)).
  A failed refresh clears the cookie. Logout is idempotent (`204` even without a cookie).
- `POST /users`: `400` when the password fails the policy (12–128 characters, not a
  common password, must not contain the email name), `409` when the email exists (case-insensitive).
- `PATCH /users/:id`: `409 conflict` if the change would leave no active admin
  ([ADR-0065](../adr/0065-last-active-admin-protection.md)). Disabling a user revokes their
  refresh tokens and rejects their access tokens within 30 s (instantly on the same replica).
- `GET /audit-log`: newest first; `action` is a **prefix** filter (e.g. `auth.` or
  `PATCH /api/v1/users`), `from` inclusive, `to` exclusive.

## Ingestion (module: ingestion)

| Method | Path                                                    | Auth                                                                                                     | Request                                                                                                                                                | Response                                                                                                 |
| ------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/alerts`                                        | A                                                                                                        | `CanonicalAlertInput`; optional `Idempotency-Key` header                                                                                               | `202 {alertId, status:"created"\|"deduplicated", duplicateOf?}`; a replay adds `Idempotent-Replay: true` |
| POST   | `/api/v1/ingest/webhooks/:sourceId`                     | HMAC (`X-Spine-Timestamp`, `X-Spine-Signature: sha256=<hex>` over `timestamp + "." + body`, ±5 min skew) | the source's format, as sent (the HMAC covers the raw bytes): JSON for `suricata-eve`/`canonical`, one text line for `cef`; optional `Idempotency-Key` | `202 IngestResult`; `401` bad signature; `404` unknown source; `400` payload the normalizer rejects      |
| POST   | `/api/v1/ingest/batch?format=ndjson\|cef\|suricata-eve` | A                                                                                                        | `text/plain` or `application/x-ndjson` body ≤ 10 MiB, one record per line                                                                              | `200 {accepted, deduplicated, rejected, skipped, errors:[{line, message}]}`                              |

Back-pressure: all ingestion endpoints return `503` + `Retry-After: 5` when the outbox backlog
exceeds `INGEST_MAX_BACKLOG` ([ADR-0034](../adr/0034-ingest-backpressure-implementation.md)).
Idempotency-Key reuse with a different body returns `409 idempotency-key-reused`; keys are
scoped per user or per webhook source and expire after 24 h ([ADR-0033](../adr/0033-ingest-transaction-race-and-idempotency.md)).

Batch counters (Phase 1 precision): `accepted` = lines that created a new alert,
`deduplicated` = lines merged into an open alert, `rejected` = invalid lines (at most 100 are
listed in `errors`, with 1-based line numbers), `skipped` = well-formed records that are not
alerts (Suricata `flow`/`dns`… events). Blank lines are ignored. Each line is its own
transaction, so a batch can partially succeed.

## Alerts & cases (module: alerts)

| Method | Path                 | Auth | Request                                                                                                                                 | Response                                                                                 |
| ------ | -------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/api/v1/alerts`     | V    | `?status&severity&minScore&maxScore&category&source&q&from&to&assigneeId&technique&sort=receivedAt\|score&order=desc\|asc&cursor&limit` | `Page<AlertSummary>`                                                                     |
| GET    | `/api/v1/alerts/:id` | V    | —                                                                                                                                       | `AlertDetail` = `{summary, alert, enrichments[], score: ScoreExplanation\|null, runs[]}` |
| PATCH  | `/api/v1/alerts/:id` | A    | `{status?, assigneeId?: id\|null, caseId?: id\|null}`; status transitions validated                                                     | `200 AlertSummary`; `409` illegal transition or reopen collision; `422` unknown case     |
| GET    | `/api/v1/cases`      | V    | `?status&cursor&limit`                                                                                                                  | `Page<Case>` (newest first)                                                              |
| POST   | `/api/v1/cases`      | A    | `{title, description?, alertIds[]}`                                                                                                     | `201 Case`; `422` unknown alert ids                                                      |
| GET    | `/api/v1/cases/:id`  | V    | —                                                                                                                                       | `CaseDetail` = `Case` + `alerts: AlertSummary[]`                                         |
| PATCH  | `/api/v1/cases/:id`  | A    | `{status?, title?, description?, addAlertIds?, removeAlertIds?}`                                                                        | `200 Case`                                                                               |

Alert status machine: `new → triaged → in_progress → resolved | false_positive`. Any open
state may go directly to `resolved` or `false_positive`. Closed alerts may be **reopened** to
`in_progress`. Setting the status an alert already has is a no-op; `resolvedAt` is the first
close and never moves ([ADR-0036](../adr/0036-alert-lifecycle-resolved-at.md)).

List semantics ([ADR-0037](../adr/0037-alert-queue-query-semantics.md)): `severity` filters the
_effective_ severity (scored severity, or the source's until scored); `source` matches vendor or
product case-insensitively; `q` is a case-insensitive substring of the title; `technique=T1059`
also matches its sub-techniques; `sort=score` puts unscored alerts last in both orders; a cursor
only works with the sort it came from. An alert belongs to at most one case.

## Enrichment & scoring (modules: enrichment, scoring)

| Method | Path                           | Auth | Purpose                                                                                     |
| ------ | ------------------------------ | ---- | ------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/alerts/:id/enrich`    | A    | Re-run enrichment (e.g. after a provider outage). `202`.                                    |
| GET    | `/api/v1/enrichment/providers` | V    | Provider list with circuit-breaker state, as `{name, state: closed\|open\|half_open, ...}`. |
| GET    | `/api/v1/scoring/ruleset`      | V    | The active ruleset (version + rules) for transparency.                                      |
| POST   | `/api/v1/scoring/preview`      | A    | `{alert, enrichments}` → `ScoreExplanation` without persisting. Useful for authoring rules. |

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
| `unprocessable`          | 422    | The body references something that doesn't exist (unknown case or alert ids)   |
| `rate-limited`           | 429    | Too many requests (`Retry-After`)                                              |
| `overloaded`             | 503    | Ingestion back-pressure (`Retry-After`)                                        |
| `internal`               | 500    | Unexpected. Body contains only the `instance` request ID for log lookup        |
