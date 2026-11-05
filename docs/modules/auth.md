# Module: auth

## Purpose

Every action in a SOC platform must be done by a known person with the right to do it, and
must leave a trace. The auth module answers three questions for the rest of Spine:
**who is calling** (login, access and refresh tokens), **may they do this** (it implements
the platform's `Authenticator` port that the RBAC hook uses), and **what did they do**
(the append-only audit log, written automatically for every mutating request). It also
manages users (admin only) and creates the first admin on a fresh install.

Design records: [ADR-0016](../adr/0016-authentication-jwt-refresh-rotation.md) (tokens,
argon2id, audit), [ADR-0017](../adr/0017-rbac-model.md) (roles), and the auth workstream's
[ADR-0060](../adr/0060-authenticator-reloads-user-with-short-cache.md) to
[ADR-0067](../adr/0067-authorize-before-body-parsing.md).

## Design

Hexagonal layout ([ADR-0002](../adr/0002-hexagonal-modular-monolith.md)):

| Layer          | Files                                                                                                                        | What lives there                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `domain/`      | `password-policy.ts`, `roles.ts`, `refresh-rotation.ts`, `login-throttle.ts`, `csrf-policy.ts`, `audit-policy.ts`            | Pure decision functions. No I/O, no clock, no framework. Unit- and property-tested.                    |
| `application/` | `sessions.ts` (login/refresh/logout), `users.ts`, `authenticator.ts`, `bootstrap.ts`, `ports.ts`, `errors.ts`                | Use cases. They depend only on the interfaces in `ports.ts`.                                           |
| `adapters/`    | `argon2-hasher.ts`, `jwt-access-tokens.ts`, `crypto.ts`, `postgres-*.ts`, `attempt-counters.ts`, `otel-metrics.ts`, `http/*` | argon2id, `jose`, SHA-256/HMAC, Kysely, Redis (Lua), OpenTelemetry, Fastify routes and the audit hook. |
| root           | `index.ts` (wiring), `public-api.ts` (what other modules may import)                                                         |                                                                                                        |

### Tokens at a glance

| Token         | Format                                                             | Lifetime                                  | Where the client keeps it                                                      | Where the server keeps it                                     |
| ------------- | ------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Access token  | JWT HS256 `{sub, role, jti, iat, exp, iss: spine, aud: spine-api}` | `AUTH_ACCESS_TTL_SECONDS` (15 min)        | Memory only (console)                                                          | Nowhere (stateless), user reloaded per request (≤ 30 s cache) |
| Refresh token | 32 random bytes, base64url (43 chars)                              | `AUTH_REFRESH_TTL_SECONDS` (7 d), sliding | `spine_refresh` cookie: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` | `refresh_tokens.token_hash` = SHA-256 only                    |

### Login and refresh flow

```mermaid
sequenceDiagram
  participant B as Browser (console)
  participant R as /auth routes
  participant S as SessionService
  participant T as Throttle (Redis)
  participant DB as Postgres
  B->>R: POST /auth/login {email, password}
  R->>S: login()
  S->>T: hit ip:<ip>, user:<hmac(email)>
  alt over 10/min on either
    S-->>B: 429 + Retry-After
  end
  S->>DB: find user by email (citext)
  S->>S: argon2id verify (dummy hash if unknown)
  S->>DB: insert refresh token (new family), audit auth.login_succeeded
  S-->>B: 200 {accessToken, expiresIn, user} + Set-Cookie spine_refresh
  Note over B,R: 15 min later
  B->>R: POST /auth/refresh (cookie, X-Spine-CSRF: 1, Origin)
  R->>R: CSRF guard (403 if header/Origin wrong)
  R->>S: refresh()
  S->>DB: BEGIN; SELECT … FOR UPDATE; decideRefresh()
  alt live token
    S->>DB: revoke it, insert successor (same family); COMMIT
    S-->>B: 200 + rotated cookie
  else revoked token presented again
    S->>DB: revoke whole family; COMMIT
    S->>DB: audit auth.refresh_token_reuse_detected (+ metric)
    S-->>B: 401, cookie cleared
  end
```

### The audit trail

The module contributes a root `onResponse` hook through `SpineModule.httpPlugins`, so it
sees **every module's** routes. For each POST/PUT/PATCH/DELETE that matched a route it
writes `{actor, action: "METHOD /route/:pattern", target, outcomeStatus, requestId, ip,
userAgent}`, never bodies ([ADR-0064](../adr/0064-audit-log-write-policy.md)). Explicit
entries (`auth.login_succeeded`, `auth.login_failed`, `auth.logout`,
`auth.refresh_token_reuse_detected`, and those other modules write through `AuditRecorder`)
add domain meaning. The table is append-only at the database level (trigger in migration
0100).

## Public API

`public-api.ts` (the only file other modules may import):

- `AuthPublicApi.authenticator`: the platform `Authenticator` (wired in `composition.ts`).
- `AuthPublicApi.audit.record(entry, trx?)`: append an explicit audit entry. Pass your
  open transaction so the entry commits or rolls back with your change (recommended for
  approvals, playbook publication). Errors propagate.

`index.ts` (composition root and CLI only): `createAuthModule(deps, overrides?)` returns
`{ module, api, seedUsers }`. `seedUsers([{ email, displayName, role, password }])` is the
idempotent seeding helper for demos, e.g.:

```ts
const auth = createAuthModule(deps);
await auth.seedUsers([
  {
    email: 'analyst@spine.test',
    displayName: 'Ana Analyst',
    role: 'analyst',
    password: 'demo-password-analyst',
  },
  {
    email: 'viewer@spine.test',
    displayName: 'Vic Viewer',
    role: 'viewer',
    password: 'demo-password-viewer',
  },
]);
```

HTTP endpoints (all under `/api/v1`, see [api-contract.md](../architecture/api-contract.md)):

| Method | Path            | Access                                        | Notes                                                                           |
| ------ | --------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/auth/login`   | public, 10/min per IP + username              | `401 invalid credentials` for every failure; `429` + `Retry-After`              |
| POST   | `/auth/refresh` | cookie + `X-Spine-CSRF: 1` + allowed `Origin` | Rotates; reuse revokes the family. `403` on CSRF failure                        |
| POST   | `/auth/logout`  | cookie + CSRF header + Origin                 | `204`; revokes the family; idempotent                                           |
| GET    | `/auth/me`      | viewer                                        | Current user                                                                    |
| GET    | `/users`        | admin                                         | Keyset-paginated by email                                                       |
| POST   | `/users`        | admin                                         | `201`; `409` duplicate email (case-insensitive); `400` password policy          |
| PATCH  | `/users/:id`    | admin                                         | `409` if it would leave no active admin; disabling revokes refresh tokens       |
| GET    | `/audit-log`    | admin                                         | Newest first; filters `actorId`, `action` (prefix), `from`, `to`; keyset cursor |

Configuration (`.env.example`): `AUTH_JWT_SECRET`, `AUTH_ACCESS_TTL_SECONDS`,
`AUTH_REFRESH_TTL_SECONDS`, `COOKIE_SECURE`, `AUTH_LOGIN_MAX_PER_MINUTE`,
`AUTH_USER_CACHE_TTL_SECONDS`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`.

Metrics: `spine_auth_logins{outcome=success|failure|throttled}`,
`spine_auth_refresh_reuse_detected` (alert on any increase).

## Invariants

| Invariant                                                                                    | Proven by                                                                                                  |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A refresh token is accepted at most once; two concurrent refreshes yield exactly one success | `auth-sessions.test.ts › lets exactly one of two concurrent refreshes with the same token succeed`         |
| Presenting a revoked token revokes its whole family, audits and counts it                    | `auth-sessions.test.ts › detects reuse of a rotated token…`; `refresh-rotation.test.ts` properties         |
| Every login failure looks the same to the client (status, body, no cookie)                   | `auth-sessions.test.ts › answers every failure with the same generic 401…`                                 |
| Exactly one argon2 verification runs per login attempt, whether or not the email exists      | `sessions.test.ts › runs exactly one dummy verification…`, `› verifies the password BEFORE revealing…`     |
| Access tokens are only accepted with HS256, `iss=spine`, `aud=spine-api`, unexpired          | `auth-sessions.test.ts › rejects alg:none, wrong audience…`; `adapters.test.ts › JwtAccessTokenService`    |
| The DB role wins over the token's role claim; disabling a user rejects their access token    | `auth-users.test.ts › applies role changes immediately…`, `› disabling a user rejects their access token…` |
| There is always at least one active admin                                                    | `roles.test.ts` property; `auth-users.test.ts › last-admin protection`                                     |
| Every mutating request leaves an audit row; no row contains bodies, passwords or tokens      | `auth-users.test.ts › audit trail`                                                                         |
| No response ever contains a password hash                                                    | `auth-users.test.ts › creates a user, never returning the password hash`, `› lists users…`                 |
| Every registered route declares the policy documented in [rbac.md](../security/rbac.md)      | `test/unit/auth/rbac-matrix.test.ts`                                                                       |

## Failure modes

| Failure                              | Behaviour                                                                                                   | How it's tested                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Redis down during login              | Throttle falls back to per-process in-memory counters; error logged                                         | `adapters.test.ts › falls back to the in-memory counter…`                                            |
| Audit insert fails                   | Request still succeeds; `audit write failed` logged at error level                                          | `sessions.test.ts › still logs the user in when the audit write fails`                               |
| Two tabs refresh at the same instant | One gets 200, the other 401 and the family is revoked → user must log in again (console must single-flight) | `auth-sessions.test.ts` race test; [ADR-0062](../adr/0062-strict-refresh-rotation-under-row-lock.md) |
| User disabled while holding tokens   | Access token rejected at next lookup (instant on this replica, ≤ 30 s elsewhere); refresh tokens revoked    | `auth-users.test.ts › disabling a user…`                                                             |
| Two API replicas bootstrap at once   | Advisory lock: exactly one admin created                                                                    | `auth-users.test.ts › first-run bootstrap`                                                           |
| Two admins demote each other at once | Row locks serialize; one 200, the other 409/403                                                             | `auth-users.test.ts › serializes two admins…`                                                        |
| Credential stuffing                  | 429 after 10/min per IP or per username, before any hashing                                                 | `auth-rate-limit.test.ts`                                                                            |
| Malformed cursor on `/audit-log`     | 400 validation-error                                                                                        | `auth-users.test.ts › serves GET /audit-log…`                                                        |

## How to extend it

**Record a domain-significant audit entry from another module** (e.g. approvals):

1. Depend on `AuthPublicApi` via a port in your module's `application/` and receive it in your module factory (wired in `composition.ts`).
2. Inside the transaction that changes your state, call
   `audit.record({ actorId, actorType: 'user', action: 'approval.decided', targetType: 'approvals', targetId, requestId, details: { decision } }, trx)`.
3. Use a dotted, past-tense action name (`<aggregate>.<verb_past>`), never put secrets or payloads in `details`.

**Add a route with a new access level**: declare `config: { access: … }`, then add a line to
`EXPECTED` in `test/unit/auth/rbac-matrix.test.ts` and to [rbac.md](../security/rbac.md).
The matrix test fails with a diff until both agree.

## How to learn this module

1. Read the domain folder first (an hour, no framework knowledge needed). Start with
   `refresh-rotation.ts` and its tests, then `login-throttle.ts`.
2. Read `application/sessions.ts` top to bottom: notice the **order** of steps in `login`.
3. Run the unit tests: `pnpm --filter @spine/api test -- src/modules/auth`.
4. Run the integration tests (Docker needed):
   `pnpm --filter @spine/api test:integration -- auth`. Then delete `.forUpdate('rt')` in
   `postgres-refresh-tokens.ts` and run them again: watch the race test fail with `[200, 200]`.
5. Log in with curl against a running stack and read the audit log as admin:
   ```bash
   curl -si -c jar -H 'content-type: application/json' \
     -d '{"email":"admin@spine.test","password":"<BOOTSTRAP_ADMIN_PASSWORD>"}' \
     http://localhost:3000/api/v1/auth/login
   curl -si -b jar -X POST -H 'x-spine-csrf: 1' -H 'origin: http://localhost:5173' \
     http://localhost:3000/api/v1/auth/refresh
   ```

### Exercises

1. **Rehash on login.** OWASP raises argon2 parameters over time. Make a successful login
   transparently re-hash the password when the stored hash uses older parameters (hint:
   `@node-rs/argon2` exports `parseOptions`). Where does the decision belong (domain,
   application or adapter), and what must stay constant for timing?
2. **Absolute session lifetime.** Today every rotation slides the refresh expiry by 7 days,
   so an active session never ends. Add a maximum family lifetime of 30 days. Which data do
   you need, and can you do it without a migration?
3. **Explain a race.** Without running it, predict the exact HTTP statuses of the
   concurrent-refresh test if `rotate` used `FOR SHARE` instead of `FOR UPDATE`. Then try it.
4. **Exponential back-off per username.** Replace the fixed 10/min per-username window by a
   delay that doubles with each consecutive failure and resets on success. Write the
   decision as a pure function with a property test first.
5. **Who can read the audit log?** An auditor role should read `/audit-log` but not manage
   users. Sketch the smallest change to ADR-0017's model that allows it and list every file
   you'd touch.

Solutions: [exercises/auth-solutions.md](exercises/auth-solutions.md) (try first!)
