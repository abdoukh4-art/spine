# ADR-0060: The authenticator reloads the user on each request, with a cache of at most 30 seconds

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** auth workstream
- **Tags:** security, architecture

## Context and problem statement

[ADR-0016](0016-authentication-jwt-refresh-rotation.md) chose short-lived JWT access tokens
(15 minutes). A JWT is a signed snapshot: once issued, it stays valid until `exp`, whatever
happens to the account. Two everyday admin actions then take up to 15 minutes to bite:

- **disabling** a user (an analyst leaves, or an account is compromised);
- **changing a role** (an admin demotes someone).

For a SOAR platform that can trigger response actions, "the fired employee can still
approve a firewall block for 15 minutes" isn't acceptable. The platform's `Authenticator`
port (`platform/http/access.ts`) turns a bearer token into a principal; the question is how
much of that principal we trust from the token and how much we look up.

## Decision drivers

- Disabling a user or changing a role must take effect quickly, not "at token expiry".
- The check runs on every authenticated request (hot path).
- Simple to reason about; no extra infrastructure (no token deny-list service).

## Considered options

1. **Verify the JWT, then load the user by id (primary-key lookup), with an in-process cache of ≤ 30 s, invalidated locally on change.**
2. Trust the JWT completely (pure stateless).
3. A revocation list (deny-list of `jti`s or "tokens issued before T" per user) in Redis.
4. Shorten the access-token TTL to 1–2 minutes.

## Decision outcome

**Chosen option 1.** `UserAuthenticator` verifies the signature, `iss`, `aud`, `exp` and the
pinned algorithm, then loads the user. A missing or disabled user gets the same
`401 invalid or expired token` as a bad token. The **role in the principal comes from the
database**, not from the token's `role` claim (which only remains for clients that want to
render the UI before calling `/auth/me`).

The cache (`AUTH_USER_CACHE_TTL_SECONDS`, default 30, max 30, 0 disables) keeps the hot
path cheap. When this process changes a user (`PATCH /users/:id`), it invalidates the
entry immediately, so on a single replica a change is instant. Other replicas pick it up
within the TTL. Disabling a user also revokes all their refresh tokens.

### Consequences

- 👍 Disable and role change take effect within 30 s worst case, instantly on the replica that made the change.
- 👍 A forged-but-validly-signed token (secret leak) can't claim a role the user doesn't have.
- 👎 The API is no longer purely stateless: one indexed `SELECT` per user per 30 s per replica.
- 👎 Up to 30 s of staleness across replicas. Accepted: it's 30× better than 15 min.
- ⚖️ The cache is bounded (10 000 entries, FIFO eviction), so memory can't grow without limit.

## Pros and cons of the options

### Trust the JWT completely

- 👍 No lookup at all.
- 👎 Up to 15 minutes of access after disabling. That's the problem we're solving.

### Revocation list in Redis

- 👍 Instant everywhere.
- 👎 Redis becomes a hard dependency of every request, plus a new data structure to keep
  consistent with the database. A user lookup gives the same effect with data we already have.

### Very short access tokens

- 👎 More refresh traffic, and still minutes of exposure. Also makes the console's refresh
  dance much more frequent, and every refresh costs a row lock (ADR-0062).

## What would make us revisit this

- The user lookup shows up in latency profiles (it shouldn't: primary key, cached).
- Many replicas and a need for instant cluster-wide revocation → publish a
  `user.changed` event and invalidate caches through Redis pub/sub.

## Further reading

- RFC 8725, _JSON Web Token Best Current Practices_
- OWASP ASVS 4.0 V3.3 (session termination)
