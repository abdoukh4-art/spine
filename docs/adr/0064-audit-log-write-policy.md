# ADR-0064: Audit log write policy: best-effort HTTP trail, transactional explicit entries, no bodies, fingerprinted emails

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** auth workstream
- **Tags:** security, data

## Context and problem statement

[ADR-0016](0016-authentication-jwt-refresh-rotation.md) asks for an append-only audit log
with an automatic entry for every mutating request plus explicit entries for significant
events (OWASP A09, Security Logging and Monitoring Failures). Several details were open:

1. If the audit write fails (database hiccup), should the request fail?
2. What exactly goes into an entry, and what must never go in?
3. How do we record a failed login without storing what the person typed as their email?

## Decision drivers

- The audit trail must be complete enough for an investigation ("who disabled this user, from where?").
- It must never become a second copy of secrets or personal data.
- An audit outage must not take the product down, but must be loud.

## Considered options

For (1):

1. **Automatic HTTP entries are best-effort (written in `onResponse`, failures logged at `error`). Explicit entries written through `AuditRecorder.record(entry, trx)` join the caller's transaction and fail with it.**
2. Fail-closed everywhere: write the entry before responding and return 500 if it fails.
3. Fire-and-forget everywhere.

For (3): store the raw attempted email; store nothing; store a plain SHA-256; **store a keyed HMAC fingerprint**.

## Decision outcome

**(1) Option 1.** The automatic trail runs in a root `onResponse` hook registered through
the platform's `SpineModule.httpPlugins` extension point. `onResponse` runs after the
response was sent, so it adds no latency and sees the final status (401/403/429 included,
which is what investigators look for). A failed write cannot change a response that has
already been sent, so we log it at `error` level with the action name, which alerting can
watch. Explicit entries are different: when a module records "approval decided" it passes
its open transaction, so the state change and its audit entry commit or roll back
together. A decision without an audit entry is impossible. Login and token-reuse entries
in the auth module use the best-effort path (a login must not fail because the audit
insert did), and that is tested (`sessions.test.ts › still logs the user in when the audit write fails`).

**(2) Content.** Actor (`user` id / `webhook` source / `anonymous`), action = `METHOD
<route pattern>` (the pattern, e.g. `PATCH /api/v1/users/:id`, so query strings never
leak in and actions group cleanly), target = first path parameter and the segment before
it (`users`, id), status code, request id, client IP and user agent (truncated to 512).
**Never** bodies, headers, cookies or tokens. Unmatched routes (404 scanner noise) and
reads are not recorded. A 403 is attributed to the authenticated caller ([ADR-0067](0067-authorize-before-body-parsing.md)).

**(3) Failed logins** record `details.reason` (`unknown_user` / `bad_password` /
`disabled`, admin-only, the client always sees "invalid credentials") and
`details.emailFingerprint = HMAC-SHA256(k, normalizedEmail)` truncated to 128 bits, where
`k` is derived from `AUTH_JWT_SECRET` with HKDF and a purpose label. People regularly type
their **password** into the email field; storing the raw value would put passwords in the
log. A plain SHA-256 of a guessable email can be confirmed offline by anyone with read
access; the keyed fingerprint still lets an admin correlate attempts (same email, same
fingerprint) and, when the account exists, the entry's `targetId` is the user id.

### Consequences

- 👍 Every mutating request, including rejected ones, leaves a row; the database rejects UPDATE/DELETE on it (migration 0100).
- 👍 No secrets in the trail; tested (`auth-users.test.ts › never stores request bodies or secrets`).
- 👎 A database outage can lose automatic entries (they're logged instead). Accepted: the
  same outage fails the mutating request itself in almost all cases.
- 👎 Rotating `AUTH_JWT_SECRET` changes email fingerprints, so correlation across a
  rotation breaks. Accepted.

## Pros and cons of the options

### Fail-closed everywhere

- 👍 A complete trail, guaranteed.
- 👎 Writing before the response means the entry can't contain the real outcome, and every request pays the latency.

### Fire-and-forget everywhere

- 👎 Domain decisions could commit without their audit entry.

## What would make us revisit this

- A compliance regime that requires guaranteed delivery of every HTTP audit record → write to the outbox in the same transaction, or ship logs to an external append-only store (WORM).
- Audit volume large enough to need partitioning by month.

## Further reading

- OWASP _Logging Cheat Sheet_ (what not to log)
- OWASP ASVS 4.0 V7 (error handling and logging)
- RFC 5869, _HKDF_
