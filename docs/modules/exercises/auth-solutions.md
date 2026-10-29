# Auth module: exercise solutions

Exercises: [auth.md › Exercises](../auth.md#exercises). Try them before reading on.

## 1. Rehash on login

The **decision** ("do these stored parameters match the current policy?") is a pure
function: put `needsRehash(stored: {m, t, p, algorithm}, current: {m, t, p, algorithm})`
in `domain/` and property-test it (equal parameters → false; any weaker parameter → true).
**Parsing** the PHC string is an adapter concern: add `needsRehash(hash): boolean` to the
`PasswordHasher` port and implement it in `Argon2PasswordHasher` with `parseOptions(hash)`
from `@node-rs/argon2` plus the domain function.

In `SessionService.login`, call it only **after** a successful verification, then
`users.updatePasswordHash(id, await hasher.hash(password))` (a new repository method).
Timing: the extra hash happens only on success, which an attacker already observes (they
got a 200), so it leaks nothing. Never rehash on failure: you'd be hashing the attacker's
guess.

## 2. Absolute session lifetime

You need the family's start time. Without a migration: the first token of a family has
the smallest `created_at`, so `SELECT min(created_at) FROM refresh_tokens WHERE family_id = $1`
inside `rotate` gives it (the `family_id` index makes this cheap). Then extend the domain
rule: `decideRefresh(state, now)` gets `familyStartedAt` and a max lifetime and returns
`{ action: 'reject', reason: 'expired' }` when `now - familyStartedAt > max`. Also cap the
successor's `expires_at` at `familyStartedAt + max`, so the cookie's Max-Age is honest.
A cleaner long-term design adds `family_started_at` to each row (a new `01xx` migration),
avoiding the aggregate.

## 3. Explain a race (`FOR SHARE`)

`FOR SHARE` lets both transactions take the lock at once (shared locks are compatible).
Both read the token as live and both try to `UPDATE` it. The first `UPDATE` must wait for
the other transaction's share lock, and the second `UPDATE` waits for the first: a
**deadlock**. Postgres detects it after `deadlock_timeout` (1 s) and aborts one
transaction with `40P01`. Result: one `200`, one `500` (an unexpected error), and the
reuse alarm never fires. Hence `FOR UPDATE`: the second reader waits _before_ reading.

We ran it: with `FOR SHARE` the test failed with `round 3: expected [ 200, 500 ] to deeply
equal [ 200, 401 ]` after about a second. Rounds 0–2 passed because the two requests
didn't overlap. Races are probabilistic, which is why the test repeats the race five times.

## 4. Exponential back-off per username

Pure rule in `domain/login-throttle.ts`:

```ts
export function backoffDelayMs(
  consecutiveFailures: number,
  baseMs = 1000,
  capMs = 15 * 60_000,
): number {
  if (consecutiveFailures < 3) return 0;
  return Math.min(capMs, baseMs * 2 ** (consecutiveFailures - 3));
}
```

Properties: monotonic non-decreasing in failures, never above the cap, zero for the first
two failures. Storage: a Redis hash `{failures, lastFailureAt}` per username fingerprint
(new methods on an `AttemptCounter`-like port), reset on success. The login use case
rejects with `TooManyAttemptsError(ceil(remaining / 1000))` when
`now < lastFailureAt + backoffDelayMs(failures)`. Keep the per-IP fixed window: back-off
alone doesn't stop one IP spraying many usernames.

## 5. An auditor role

The roles are a total order (`viewer < analyst < admin`), and "can read the audit log but
can't triage alerts" doesn't fit anywhere on that line. Options:

- **Smallest change:** add a capability flag instead of a role, e.g. `users.can_read_audit boolean`,
  and a new access policy `{ role: 'viewer', capability: 'audit:read' }` checked in
  `platform/http/access.ts`. Files: a new `01xx` migration, `platform/db/schema.ts`,
  `platform/http/access.ts` (policy type + check), the `Principal` type, `UserAuthenticator`
  (load the flag), `UserSchema`/`UpdateUserRequestSchema` in `shared-schema` (additive),
  `admin-routes.ts` (`GET /audit-log` policy), `rbac-matrix.test.ts`, `rbac.md`, and a new
  ADR superseding part of ADR-0017.
- Adding `auditor` to `ROLES` breaks `roleSatisfies`, because every role would then have to
  sit somewhere on the line.
