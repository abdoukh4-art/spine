# ADR-0065: The system always keeps at least one active admin

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** auth workstream
- **Tags:** security, data

## Context and problem statement

Only admins can manage users. If the last active admin demotes or disables themselves (by
mistake, or because a compromised session does it on purpose), nobody can ever manage users
again without direct database access. The prompt asked for "an admin can't disable or
demote themselves if they're the last active admin"; we had to decide the exact rule and
how to enforce it under concurrency.

## Decision drivers

- No API call may leave zero active admins.
- Two admins demoting each other at the same moment must not both succeed.
- Rule testable without a database.

## Considered options

1. **Invariant on the whole system: no `PATCH /users/:id` may leave zero active admins (whoever the target is), enforced under row locks.**
2. Only forbid self-demotion/self-disable (any admin, last or not).
3. Check the count without locks.

## Decision outcome

**Chosen option 1.** "Active admin" = `role = 'admin' AND NOT disabled`. The pure rule
`wouldRemoveLastActiveAdmin(activeAdminIds, current, next)` (property-tested: after any
allowed change at least one active admin remains) runs inside a transaction that first
locks **all active admin rows in id order** (`SELECT … FOR UPDATE`), then the target row.
Locking in a fixed order avoids deadlocks; locking the admin set (not just the target)
serializes two admins demoting each other. A violation returns
`409 conflict: this change would leave no active admin`.

Because the caller of `PATCH /users` is always an active admin, "the last active admin"
can only be the caller, so option 1 includes the requested self rule. It's phrased as a
system invariant because that's what we actually care about. Self-demotion when another
admin remains is allowed (a legitimate hand-over).

### Consequences

- 👍 Proven under concurrency: `auth-users.test.ts › serializes two admins demoting each other`.
- 👎 Locking every admin row on each user update. There are a handful of admins; fine.
- ⚖️ The first-run bootstrap ([ADR-0066](0066-first-run-admin-bootstrap.md)) guarantees an admin exists to begin with.

## Pros and cons of the options

### Self-only rule

- 👎 Doesn't prevent A and B demoting each other concurrently, which also ends with zero admins.

### Unlocked count

- 👎 Check-then-act race: both transactions see two admins, both proceed.

## What would make us revisit this

- User deletion is added (the same rule applies to DELETE).
- Admin management moves to an external IdP.

## Further reading

- Martin Kleppmann, _Designing Data-Intensive Applications_, ch. 7 "Write skew and phantoms"
