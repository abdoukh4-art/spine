# ADR-0067: Authorize in `onRequest` (before body parsing) and attribute forbidden requests

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** auth workstream
- **Tags:** security, architecture

## Context and problem statement

The Phase 0 platform enforced `config.access` in a global `preHandler` hook. In Fastify's
lifecycle, `preHandler` runs **after** body parsing and schema validation
(`onRequest → preParsing → preValidation → validation → preHandler → handler`). The auth
RBAC test caught the consequence: an anonymous `POST /api/v1/users` with an empty body got
`400 validation-error`, listing the expected fields, instead of `401`. Unauthenticated
callers could map request schemas, and we parsed bodies for callers who weren't allowed
to send them.

Separately, the principal was attached only after the role check passed, so the audit
log recorded a `403` as `anonymous` even though we knew exactly who tried.

## Decision drivers

- Unauthenticated or unauthorized callers learn nothing beyond 401/403 (OWASP A01).
- Do the cheapest rejection first.
- Forbidden attempts must be attributable (OWASP A09).

## Considered options

1. **Move the access hook to `onRequest`; set `request.principal` before the role check.**
2. Move it to `preValidation` (after parsing, before validation).
3. Keep `preHandler`.

## Decision outcome

**Chosen option 1.** Routing has already happened in `onRequest`, so
`request.routeOptions.config.access` is available. Hooks run in registration order, so the
platform's CORS and global rate-limit hooks still run first. Webhook routes are unaffected
(their HMAC check needs the body and runs in the route itself).

Setting the principal before the role check grants nothing: on `403` no handler runs, so
the principal is only read by `onResponse` hooks such as the audit trail.

### Consequences

- 👍 `401/403` before any parsing or validation; tested in `auth-users.test.ts › RBAC on admin routes`.
- 👍 A `403` row in the audit log names the user who tried.
- ⚖️ Platform change (two lines) made by the auth workstream because its tests found it; existing platform tests still pass.

## Pros and cons of the options

### `preValidation`

- 👍 Also hides schemas.
- 👎 Still parses (up to 1 MiB) bodies for anonymous callers.

## What would make us revisit this

- A route needs the body to authorize (e.g. per-resource ownership in the body) → do that check in the handler, keeping the coarse check here.

## Further reading

- Fastify docs, "Lifecycle" and "Hooks"
- OWASP Top 10 2021, A01 Broken Access Control
