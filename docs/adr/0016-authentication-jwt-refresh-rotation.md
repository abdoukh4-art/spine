# ADR-0016: Authentication with short-lived JWT access tokens, rotating opaque refresh tokens, argon2id, and an audit log

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** security

## Context and problem statement

Spine's console and API must authenticate analysts. A SOAR platform holds sensitive data
(indicators, asset owners) and can trigger response actions, so stolen sessions are
high impact. Every mutating action must be attributable to a person (an audit requirement).

## Decision drivers

- OWASP ASVS V2 (authentication), V3 (session management), V7 (logging).
- A stateless check on the hot path, with revocation within minutes.
- Resistance to XSS token theft and to CSRF.
- Password storage that resists GPU cracking.

## Considered options

1. **15-min JWT access token (in memory) + 7-day opaque refresh token (httpOnly cookie, rotated on every use, with reuse detection) + argon2id**
2. Server-side sessions only (session ID cookie + Redis/Postgres session store)
3. Long-lived JWT in `localStorage`
4. Delegate to an external IdP (OIDC with Keycloak/Auth0)

## Decision outcome

**Chosen option 1.**

- **Access token:** JWT, `alg: HS256` with a ≥ 32-byte secret from env
  (`AUTH_JWT_SECRET`), signed with `jose`. Claims are `sub`, `role`, `iat`, `exp` (15 min),
  `iss: spine`, `aud: spine-api` and `jti`. On verification the algorithm is **pinned** to
  `HS256` (preventing `alg: none` / algorithm-confusion attacks). Sent as `Authorization: Bearer`.
  The console keeps it **in memory only**, never in `localStorage`.
- **Refresh token:** 256-bit random opaque string. Only its SHA-256 hash is stored in
  `refresh_tokens(id, user_id, family_id, token_hash, expires_at, revoked_at, replaced_by)`.
  It's delivered as an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie.
- **Rotation with reuse detection:** every `/auth/refresh` revokes the presented token and
  issues a new one in the same family. If a **revoked** token is presented again (a sign
  of theft), the **whole family is revoked** and the event is audited.
- **Passwords:** argon2id (`@node-rs/argon2`) with OWASP-recommended parameters
  (m=19 MiB, t=2, p=1), and a timing-safe dummy verify when the user doesn't exist (no user enumeration).
- **Login throttling:** per-IP and per-username rate limits on `/auth/login` (see [ADR-0024](0024-api-conventions.md)).
- **CSRF:** API calls use the `Authorization` header, which is not sent automatically by
  browsers, so they're not CSRF-able. The only cookie-authenticated endpoints
  (`/auth/refresh`, `/auth/logout`) need `SameSite=Strict` **and** an `Origin` header
  that matches `CORS_ALLOWED_ORIGINS` **and** the custom header `X-Spine-CSRF: 1`. A
  cross-site form cannot set a custom header without a CORS preflight, which we deny.
- **Audit log:** an `onResponse` hook records every mutating request (POST/PUT/PATCH/DELETE)
  with `actor`, `action` (route + method), `target`, `outcome` (status code), `requestId`,
  `ip` and `userAgent`. Domain-significant actions (approval decisions, playbook publication,
  login success/failure, token-reuse detection) also write explicit, richer audit entries.
  The table is append-only: the application DB role has no `UPDATE`/`DELETE` grant on it,
  as documented in the threat model.

### Consequences

- 👍 A stolen access token is useful for at most 15 minutes. A stolen refresh token is
  detected on its first reuse.
- 👍 XSS can't read tokens from storage, though it could still act within the page
  session (CSP mitigates; see [threat model](../security/threat-model.md)).
- 👎 More complex than sessions. There's a refresh dance in the console.
- 👎 HS256 means the API holds the signing secret. Fine for a single service; switch to
  EdDSA key pairs if other services need to verify tokens.

## Pros and cons of the options

### Server-side sessions
- 👍 Simple and instantly revocable.
- 👎 A store lookup on every request. Equally valid; we chose JWT partly because the target
  job market expects JWT literacy, and rotation plus reuse detection teaches more.

### JWT in localStorage
- 👎 Readable by any XSS. An anti-pattern.

### External IdP
- 👍 SSO, MFA and enterprise-grade features.
- 👎 Not offline-friendly for the demo. It's the recommended production path, listed in the roadmap.

## What would make us revisit this

- Enterprise deployment → OIDC SSO with MFA (a superseding ADR).
- Multiple services verify tokens → asymmetric signing (EdDSA) with JWKS.

## Further reading

- OWASP ASVS 4.0, V2/V3; OWASP *Password Storage Cheat Sheet*
- Auth0 blog, *Refresh Token Rotation*
- RFC 8725, *JSON Web Token Best Current Practices*
