# ADR-0070: Console API client: always validate responses, single-flight token refresh, injected client

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** console workstream
- **Tags:** frontend, security

## Context and problem statement

The console talks to one backend through roughly 30 endpoints. Three things can go wrong at
that boundary, and each one is easy to get subtly wrong in a browser:

1. **Contract drift.** The API and the console are built by different people in parallel. If a
   field is renamed, a hand-typed `fetch(...).then(r => r.json() as AlertSummary)` compiles and
   then renders `undefined` somewhere deep in the UI.
2. **Expired access tokens.** Access tokens live 15 minutes ([ADR-0016](0016-authentication-jwt-refresh-rotation.md)).
   When one expires, several queries usually fail at the same moment (a page fires 2–5 requests).
   If each of them calls `POST /auth/refresh`, the server sees the refresh token used several
   times. With rotation and reuse detection, the second use looks like **token theft** and
   revokes the whole session family: the analyst is logged out for no reason.
3. **Testability.** Components that import a global `fetch` wrapper can only be tested by
   monkey-patching globals.

ADR-0023 said responses would be parsed "in development". We had to decide whether that is
enough, and how the refresh dance should work.

## Decision drivers

- A contract break must fail loudly and close to its cause, not as a blank cell.
- One refresh per expiry, never more (reuse detection must not fire on legitimate traffic).
- The access token must stay out of Web Storage (XSS can read it there).
- The client must be swappable in tests and in the standalone demo.

## Considered options

1. **Validate every response with the shared Zod schemas, in every build; a hand-written client
   with a single in-flight refresh promise; inject the client through React context.**
2. Validate only in development (`import.meta.env.DEV`), trust types in production.
3. Use a generated client (openapi-typescript + openapi-fetch) and an interceptor library for refresh.
4. Refresh proactively on a timer before `expiresIn` elapses, never reactively on 401.

## Decision outcome

**Chosen option 1.**

- `HttpClient.request({ path, schema })` always runs `schema.safeParse(body)`. A failure throws
  `ContractError` naming the endpoint and the first mismatching paths; the UI shows "the server
  sent data the console does not understand" instead of rendering half an object.
- Non-2xx responses are parsed as RFC 9457 problems into `ApiError { status, type (slug),
title, detail, instance, errors[] }`. Bodies that aren't problems still become an `ApiError`.
- On a 401 the client: (a) if another request already refreshed while this one was in flight
  (the current token differs from the one this request used), retries with the new token
  without refreshing; otherwise (b) joins the **single in-flight** `POST /auth/refresh`
  (`credentials: 'include'`, `X-Spine-CSRF: 1`), then retries **once**. A refused refresh, or a
  401 on the retry, clears the session, which logs the user out.
- The token lives in a private field of the `HttpClient` instance. React state only mirrors the
  _user_. On page load the `AuthProvider` performs a silent refresh, so a reload keeps the
  session through the HttpOnly cookie.
- The client is created in `main.tsx` and provided through `ApiProvider`; components call `useApi()`.

### Consequences

- 👍 Contract drift between the parallel backend modules and the console surfaces in the first
  test or demo run, with a precise message.
- 👍 A burst of expired requests costs exactly one refresh (proved by `http.test.ts`
  "de-duplicates concurrent 401s" and `App.test.tsx` "refreshes once when several requests hit 401").
- 👍 Tests inject a client backed by the fake API (ADR-0071); no global mocks.
- 👎 Zod parsing costs CPU on every response, and the full Zod runtime (~55 kB gzip) is in the
  main bundle. For pages of 25–50 alerts this is well under a millisecond; we accept it.
- 👎 A stricter schema on the client than on the server would reject valid data. Mitigation:
  both sides use the same `@spine/shared-schema` objects.

## Pros and cons of the options

### Validate only in development

- 👍 Zero production cost.
- 👎 Production is exactly where an unexpected backend version shows up. The cost we'd save is tiny.

### Generated client + interceptor library

- 👍 Less hand-written code.
- 👎 Two more dependencies, and generated types don't validate at runtime. Interceptor
  libraries don't de-duplicate concurrent refreshes by default; we'd write that part anyway.

### Proactive timer-based refresh

- 👍 Fewer 401s.
- 👎 Timers drift when a laptop sleeps, and the server can revoke tokens at any time, so the
  reactive path is needed regardless. It can be added on top later.

## What would make us revisit this

- Profiling shows response validation above ~5 % of main-thread time on a real page.
- The API adds endpoints whose responses are large (exports, bulk views): validate those lazily.

## Further reading

- Auth0 blog, _Refresh Token Rotation_ (reuse detection)
- RFC 9457, _Problem Details for HTTP APIs_
