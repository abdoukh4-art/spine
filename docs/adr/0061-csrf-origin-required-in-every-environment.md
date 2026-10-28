# ADR-0061: CSRF on cookie endpoints: custom header and an allow-listed Origin, required in every environment

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** auth workstream
- **Tags:** security

## Context and problem statement

`/auth/refresh` and `/auth/logout` authenticate with the `spine_refresh` cookie, which the
browser attaches automatically. That makes them the only CSRF-able endpoints in Spine
(everything else needs an `Authorization` header a browser never adds on its own).
[ADR-0016](0016-authentication-jwt-refresh-rotation.md) asks for `SameSite=Strict`, the
`X-Spine-CSRF: 1` header **and** an `Origin` on the allow-list. One detail was left open:
what to do when the `Origin` header is **absent**? Non-browser clients (curl, test code)
usually don't send one. A tempting shortcut is "allow a missing Origin when `NODE_ENV=test`".

## Decision drivers

- Tests must exercise the rule that runs in production, not a test-only variant.
- No reduction in protection for real browsers.
- Scripts and end-to-end tests can still call the endpoints.

## Considered options

1. **Require the custom header AND an allow-listed Origin, always. A missing Origin is rejected in every environment.**
2. Allow a missing Origin only when `NODE_ENV=test`.
3. Allow a missing Origin in every environment (rely on the custom header alone).

## Decision outcome

**Chosen option 1.** The rule lives in a pure function (`domain/csrf-policy.ts`) and runs as
a `preHandler` on both routes. It rejects with `403 CSRF check failed` when:

- `X-Spine-CSRF` isn't exactly `1`;
- `Origin` is missing or empty;
- `Origin` is the literal `null` (sandboxed iframes, `file://`), or isn't **exactly** one
  of `CORS_ALLOWED_ORIGINS` (scheme + host + port; `https://spine.test.evil.example`
  doesn't match `https://spine.test`).

Why rejecting a missing Origin costs nothing: browsers send `Origin` on every POST
(same-origin `fetch` included), so legitimate console traffic always has it. A non-browser
client isn't a CSRF victim, and it can set `Origin` itself (our tests do).

Why not a test exemption: an environment switch in a security control is a classic way
for the test suite to pass while production behaves differently, and for a misconfigured
production (`NODE_ENV` unset or wrong) to silently run the weaker rule.

### Consequences

- 👍 One rule everywhere; the integration tests (`auth-sessions.test.ts › CSRF on cookie endpoints`) prove the production behaviour.
- 👍 Three independent layers: SameSite, custom header (needs a CORS preflight we deny), Origin.
- 👎 Scripts must send `Origin: <an allowed origin>` and `X-Spine-CSRF: 1` to refresh. Documented in [auth.md](../modules/auth.md).

## Pros and cons of the options

### Test-only exemption

- 👍 Slightly shorter test code.
- 👎 Tests no longer prove the production rule; a mis-set `NODE_ENV` weakens production.

### Header only

- 👍 Simplest; the custom header alone already defeats HTML-form CSRF.
- 👎 Loses defence in depth if a CORS misconfiguration ever allowed the header cross-site.

## What would make us revisit this

- A legitimate browser flow that omits `Origin` (none known for POST).
- Moving refresh to a different mechanism (e.g. DPoP-bound tokens).

## Further reading

- OWASP _Cross-Site Request Forgery Prevention Cheat Sheet_ (custom request headers, verifying origin)
- Fetch Standard, §3.1 "`Origin` header"
