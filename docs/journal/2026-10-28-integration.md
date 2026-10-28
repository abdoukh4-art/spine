# 2026-10-28 (evening) — Integration: when parallel work meets reality

## Context

Six workstreams built their modules in parallel against a written contract, each with green
CI. This session merged them, replaced every `// INTEGRATION` placeholder in the composition
root, and ran the whole system for the first time: Docker stack, demo story, browser.
**Every module was "done" and green, and the integrated system still had five bugs.** That
gap is what this entry is about.

## What I did

1. Merged the five remaining branches into `develop`, resolving the ADR/journal index
   conflicts (table rows: take the union, sort by number) and regenerating `openapi.json`
   instead of hand-merging it. A generated file is never merged, it's regenerated.
2. Wired the real public APIs in `composition.ts`. Two modules need each other (alerts shows
   playbook runs; playbooks change alert status), so the earlier one gets **late-bound
   closures** (`(id) => playbooks.api.runsForAlert(id)`); by the time a request arrives,
   every module exists.
3. Gave the Metrics module its data through **reporting queries on the owners' public APIs**
   (`alerts.timesReceivedBetween`, `playbooks.runTimesBetween`) instead of letting it read
   their tables (ADR-0029).
4. Wrote an **end-to-end integration test** that runs the real worker machinery in-process:
   outbox relay, BullMQ, subscribers, playbook executor.
5. Added contract tests, the demo seeder, `make demo` and Playwright journeys.

## The bugs, one by one

### 1. A test that passes first time is a test you haven't seen fail

The end-to-end test passed on its first run. That's suspicious for a 300-line pipeline.
_Experiment:_ break one wiring on purpose (`runsFor: () => Promise.resolve([])`).
_Result:_ the test failed with `expected [] to include '01a1…'`, so it really observes the wiring.
I reverted the sabotage. **Lesson:** mutation-test your most important tests by hand.

### 2. The console image only failed inside Docker

`vite build` passed locally, but the console image build failed in CI with
`pnpm --filter @spine/console build … exit code 2`. CI logs were unreachable from my environment
(the log host was blocked), so I reproduced the build step outside Docker: a copy of the repo
filtered by `.dockerignore`, then the same filtered install and build.
_Result:_ `src/test-setup.ts(4,26): Cannot find module './test/time'`. `.dockerignore` drops
`**/test`, but the production type-check included test setup code.
_Fix:_ `tsconfig.build.json` without test code; `pnpm typecheck` still checks everything.
**Lesson:** when you can't read the logs, rebuild the failing environment's _inputs_.

### 3. "Why did the scanner score 30?" (a domain bug the demo found)

The demo's "noise" alert, a port scan _from_ the authorized vulnerability scanner _to_ the
finance database server, scored 30 (low) instead of near zero. The explanation showed
`critical-asset +20` and no `authorized-scanner −25`.
_Hypothesis:_ the scanner rule reads `enrichment.asset.tags`, and `asset` is the **most critical**
asset, which is the target here, not the scanner. _Experiment:_ a unit test with two assets
(critical target, low scanner tagged `authorized-scanner`). _Result:_ `assetTags` absent, rule
silent. _Fix:_ `enrichment.assetTags` = union of all assets' tags, used by the rule, plus a
regression test. After the fix the alert scored 5 (informational).
**Lesson:** unit tests check the code against _your_ model of the world; a realistic scenario
checks your model against the world.

### 4. Logged in, then logged out by a page reload

Playwright: login worked, but `page.goto('/alerts')` landed on the login page.
_Hypothesis:_ the silent refresh (cookie → new access token) is rejected. _Experiment:_
`curl` the refresh endpoint with `Origin: http://localhost:8080`.
_Result:_ `403 CSRF check failed`. The default `CORS_ALLOWED_ORIGINS` listed the Vite dev
server and the TLS port, but not the nginx HTTP origin the demo uses. The CSRF defence from
ADR-0061 worked exactly as designed, and the configuration was wrong. _Fix:_ the default
allow-list includes `http://localhost:8080`.
**Lesson:** security controls fail closed. When something "randomly logs you out", check the control first.

### 5. `make up` worked on my machine and nowhere else

The new CI `e2e` job failed at "Start the stack". The logs were again unreachable, so I reasoned
from differences: locally I had set `BUILD_CA_FILE` (for this environment's TLS proxy); CI used
the default `/dev/null`. _Experiment:_ build with a CI-like `.env`. _Result:_
`additional privileges requested: pass "--allow=fs.read=/dev/null"`. Compose's bake builder
refuses secret files outside the project. _Fix:_ default to an empty file in the repo.
**Lesson:** "works on my machine" usually means "my machine has a setting yours doesn't". Diff the configuration, not the code.

### 6. The spec said `application/json`; the server said `application/problem+json`

The new contract test validates real responses against the committed `openapi.json`. Happy paths
all matched, and the 404 didn't: errors were documented under `application/json` while the
server (correctly, RFC 9457) sends `application/problem+json`. _Fix:_ the OpenAPI generator now
re-keys 4xx/5xx responses (50 of them). **Lesson:** a generated spec is only as true as the
generator, so test the spec against behaviour.

### Unexplained: one flaky run

The end-to-end integration test failed once, right after a type-only edit, and then passed
6/6 in isolation and in 3/3 full-suite runs. I don't know why, and I'm not going to pretend
otherwise. Candidates: leftover BullMQ jobs from an earlier killed run in the shared Redis
container (the test flushes its own DB index, but a previous process might still have been
draining), or a timing window in `expect.poll`. It's recorded in STATUS as a known issue, and CI
runs the test on every push. If it recurs, the next step is to capture the worker's logs
for that run.

## Things I'd tell a junior engineer

- **Integration is where the bugs are.** Six green PRs, five real bugs. Budget for it.
- **Write the demo early.** The scripted story found a scoring bug and a config bug that no unit test could.
- **Prefer a reproduction you control** over logs you can't reach.
- **Never hand-merge generated files.** Regenerate them.
