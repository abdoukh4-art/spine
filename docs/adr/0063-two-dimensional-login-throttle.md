# ADR-0063: A small two-dimensional login throttle (Redis fixed window, in-memory fallback) instead of @fastify/rate-limit

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** auth workstream
- **Tags:** security, architecture

## Context and problem statement

[ADR-0024](0024-api-conventions.md) requires `/auth/login` to allow 10 attempts per minute
per client IP **and** 10 per username, with `429` + `Retry-After`. The platform already
registers `@fastify/rate-limit` globally (600/min per IP). The obvious plan was to attach
two more limiters to the login route with the plugin's `fastify.rateLimit()` helper.

Reading the plugin source (v10.3.0) showed why that doesn't work: the request handler
marks the request with a `rateLimitRan` symbol and **returns early if any limiter already
ran**. The global limiter always runs first, so a second and third limiter on the same
request are silently skipped. The test for the per-username dimension would have passed
only if we never looked at it carefully. Also, the username is in the **body**, which the
plugin's default `onRequest` hook can't see.

## Decision drivers

- Both dimensions must really be enforced (and tested).
- Limits must hold across API replicas.
- A Redis outage must neither lock everyone out nor silently disable throttling.
- No raw emails in Redis keys.

## Considered options

1. **Own `AttemptCounter` port: an atomic Lua fixed-window counter in Redis, an in-memory fallback, and a pure `decideThrottle` rule.**
2. `@fastify/rate-limit` with a single composite key (`ip + username`).
3. `@fastify/rate-limit` with `groupId` and two separately registered routes.

## Decision outcome

**Chosen option 1.**

- `SessionService.login` counts the attempt in both buckets **before** any database or
  argon2 work (throttled requests cost almost nothing, which also blunts CPU-exhaustion
  attacks against argon2).
- Buckets: `ip:<request.ip>` and `user:<HMAC fingerprint of the normalized email>`
  (normalized = NFKC + trim + lowercase, so `Alice@X` and `alice@x` share one bucket).
- Redis: one `EVAL` does `INCR`, sets `PEXPIRE` on the first hit, and returns the count and
  the remaining TTL, atomically. A crash can't leave a counter without expiry.
- `decideThrottle` (pure, property-tested) blocks if **any** dimension exceeds the limit
  and returns the **longest** remaining window as `Retry-After` (never 0).
- `FallbackAttemptCounter` uses the in-memory counter when Redis errors, and logs it:
  limits become per-process for the duration of the outage, which is better than both
  failing every login (fail-closed) and having no limit (fail-open).
- Every attempt counts, successful or not. A human doesn't log in ten times a minute.
- Throttled attempts are counted in `spine_auth_logins{outcome="throttled"}` and logged at
  `warn`, but **not** written to the audit log, so an attack can't flood it.

### Consequences

- 👍 Both dimensions are enforced and integration-tested (`auth-rate-limit.test.ts`).
- 👍 ~60 lines of code we fully understand; easy to teach.
- 👎 A per-username limit lets an attacker lock a known user out for one minute at a
  time (by spending 10 attempts per minute). Accepted: the lockout is short and self-healing,
  and the per-IP limit caps a single attacker. See "revisit".
- ⚖️ Fixed windows allow up to 2× the limit around a window boundary. Fine at 10/min.

## Pros and cons of the options

### Composite key in the plugin

- 👍 No new code.
- 👎 `ip+username` isn't either dimension: a botnet rotating IPs or one IP rotating
  usernames would both pass.

### Plugin with `groupId` and two routes

- 👎 Contorts the API to suit a library, and still can't read the body in `onRequest`.

## What would make us revisit this

- Account-lockout abuse becomes a real problem → add an exponential back-off per username, or a CAPTCHA after N failures.
- `@fastify/rate-limit` supports stacking limiters on one request.

## Further reading

- OWASP _Authentication Cheat Sheet_, "Protect against automated attacks"
- OWASP _Credential Stuffing Prevention Cheat Sheet_
- Redis docs, "Rate limiting pattern" (`INCR` + `EXPIRE`)
