# ADR-0071: An in-browser, typed fake of the API for console tests and the standalone demo

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** console workstream
- **Tags:** frontend, testing

## Context and problem statement

The console was built at the same time as the backend modules it calls, so for most of the
work there was no backend to call. We still needed (a) tests that exercise real behaviour (the
refresh dance, 409s, pagination, role checks) rather than mocked hooks, (b) a way to demo and
screenshot the console without Postgres and Redis, and (c) one source of realistic data for both.

## Decision drivers

- Tests should go through the **real** HTTP client, including schema validation.
- No new runtime dependency (ADR-0023), and the fake must never ship in the production bundle.
- The fake must be faithful enough to catch mistakes: roles, transitions, 409s, cursors.
- Deterministic data, so tests and screenshots are reproducible.

## Considered options

1. **A hand-written fake server that implements `fetch`, injected into the real `HttpClient`.**
2. Mock Service Worker (MSW) handlers.
3. Mock the API module (`vi.mock('../lib/api')`) per test.
4. Run the real API in tests (Testcontainers) and for the demo.

## Decision outcome

**Chosen option 1.** `src/fake/` contains:

- `fixtures.ts`, `alerts.ts`, `playbooks.ts`: deterministic fixtures built relative to a
  given "now" (a seeded PRNG for the 140 background alerts), validated against the shared
  schemas by `fake.test.ts`.
- `server.ts` + `routes.ts`: `FakeSpineServer.fetch` routes every contract endpoint the console
  uses, enforces each route's minimum role (deny by default), validates bodies with the shared
  request schemas (400 `validation-error`), applies the alert state machine (409), decides
  approvals (409 when decided or expired), paginates with opaque cursors, and answers with RFC
  9457 problems. Runs advance one event per poll so the run timeline visibly progresses.
- Test hooks: `signInAs`, `expireAccessTokens`, `failNext(method, path, status)`, `requests[]`.
- `demo.ts`: the same server with 250 ms latency and a fake-only cookie holding the demo
  user id, so a page reload keeps the demo session the way the HttpOnly cookie would.

`main.tsx` loads `fake/demo` through a dynamic `import()` guarded by
`import.meta.env.VITE_USE_FAKE_API === 'true'`. Vite replaces that constant at build time, so a
normal build does not even emit the fake chunk.

### Consequences

- 👍 Page tests render the whole app (router, auth, lazy pages) and assert on what the user sees
  and on what the server received.
- 👍 `VITE_USE_FAKE_API=true pnpm --filter @spine/console dev` is a full standalone demo.
- 👍 Writing the fake found a bug in itself: an early version authenticated but never checked
  route roles, which the contract tests caught (see the journal).
- 👎 The fake can drift from the real API. Mitigations: it uses the shared schemas for every
  request and response, and the lead's integration phase runs the console against the real API.
- 👎 YAML playbook validation in the fake is structural only (a YAML parser would be a new
  dependency in the bundle); JSON validation uses the real schema.

## Pros and cons of the options

### MSW

- 👍 Industry standard, intercepts at the network layer, works in browser and Node.
- 👎 A new dependency with a service worker to register for the demo. We need injection anyway
  (ADR-0070), which makes interception unnecessary.

### Mocking the API module

- 👎 Bypasses the client, so the refresh flow, validation and error parsing go untested.

### The real API

- 👍 Maximum fidelity.
- 👎 The backend didn't exist yet; the demo would need Docker. Belongs in the e2e suite.

## What would make us revisit this

- The real API is stable and an e2e suite covers the same flows: shrink the fake to the demo only.
- Fake/real drift causes a bug that tests didn't catch: generate fake handlers from `openapi.json`.

## Further reading

- Martin Fowler, _Mocks Aren't Stubs_ (fakes vs mocks)
- Kent C. Dodds, _Stop mocking fetch_
