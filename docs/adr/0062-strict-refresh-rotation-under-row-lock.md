# ADR-0062: Strict refresh-token rotation under a row lock, with no grace window

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** auth workstream
- **Tags:** security, data

## Context and problem statement

Refresh rotation ([ADR-0016](0016-authentication-jwt-refresh-rotation.md)) is a
read-decide-write sequence: read the presented token, check it's live, revoke it, insert
its successor. Done naively, two requests carrying the same token can both read "live" and
both rotate. If one of them is an attacker replaying a stolen token, they end up with a
valid parallel session and reuse detection never fires.

We also have to decide what a **legitimate** double refresh means: two console tabs that
refresh at the same moment send the same cookie twice.

## Decision drivers

- At most one successor per token, provably, under concurrency.
- Reuse detection must not be defeatable by timing.
- Keep it in Postgres (the system of record); no distributed lock service.

## Considered options

1. **`SELECT … FOR UPDATE` on the token row inside one transaction; the loser sees a revoked token and triggers reuse detection (strict, no grace window).**
2. Same lock, plus a short grace window (e.g. 10 s) during which presenting the just-rotated token returns the already-issued successor instead of revoking the family.
3. Optimistic concurrency: `UPDATE … SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL` and check the affected row count.

## Decision outcome

**Chosen option 1.** `PostgresRefreshTokenRepository.rotate` locks the row
(`FOR UPDATE OF rt`, joined with `users` to see `disabled`), applies the pure
`decideRefresh` rule, and revokes + inserts in the same transaction. A second concurrent
request blocks on the lock, then reads `revoked_at IS NOT NULL` and is treated as
**reuse**: the whole family is revoked, `auth.refresh_token_reuse_detected` is audited and
`spine_auth_refresh_reuse_detected` is incremented.

The rule order matters and is unit-tested: reuse is checked **before** expiry, so
replaying an old, revoked _and_ expired token still raises the alarm.

`auth-sessions.test.ts › lets exactly one of two concurrent refreshes with the same token succeed`
runs the race five times. Removing `forUpdate` makes it fail with `[200, 200]`
(see the [journal](../journal/2026-10-28-auth.md)).

### Consequences

- 👍 Exactly one success per token, proven by a test that fails without the lock.
- 👍 Simple, auditable rule: a revoked token is never accepted, full stop.
- 👎 Two tabs refreshing simultaneously log the user out (family revoked). The console must
  **single-flight** its refresh (one in-flight refresh shared by all callers, and a
  `BroadcastChannel`/storage-event handoff between tabs). Noted for the console workstream.
- 👎 A logged-out token presented again is also reported as reuse. It is suspicious anyway
  (the browser cleared the cookie), and the family is already revoked, so no harm is done.

## Pros and cons of the options

### Grace window

- 👍 Friendlier to racing tabs.
- 👎 Must store the successor's raw token (or re-issue it) to return it, which defeats
  hashing at rest. It also gives a thief a window in which a replay is not detected.

### Optimistic `UPDATE … WHERE revoked_at IS NULL`

- 👍 No explicit lock; also race-safe.
- 👎 The decision logic splits between SQL and code, and distinguishing "unknown" from
  "already revoked" needs a second query anyway. The lock keeps the pure domain rule in one place.

## What would make us revisit this

- Users complain about being logged out with multiple tabs even after single-flight in the console → consider option 2 with a hashed successor lookup.
- Refresh traffic large enough that row locks show up in contention metrics.

## Further reading

- Auth0, _Refresh Token Rotation_ and _automatic reuse detection_
- PostgreSQL docs, "Explicit Locking: Row-Level Locks"
- OAuth 2.0 Security BCP (RFC 9700), §4.14 refresh token protection
