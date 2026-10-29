# 2026-10-28: Enrichment and scoring (Phase 1)

## Goal of the session

Build the part of the pipeline between "an alert arrived" and "an alert has an explained
score": the `@spine/enrichers` package (provider port, resilience primitives, mock
providers), the enrichment and scoring modules in the API, ruleset v1, and the docs a
newcomer needs to follow all of it.

## What I did, in order, and why

1. **Read before writing.** Vision, the ADRs (0002, 0009, 0013, 0014, 0015, 0019, 0021),
   the contracts, and the platform kernel. Two details from that reading shaped the code:
   - `EventPublisher.publish(trx, …)` takes a Kysely executor, so "state change + event in
     one transaction" is a property of the _adapter_. I gave each module a small
     `transaction(work)` port so the application layer never sees Kysely.
   - The predicate interpreter makes a missing value false for **every** operator,
     including `neq`. That became the core of the scoring guide's "semantics to remember",
     and of exercise 2.
2. **Resilience primitives first, with property tests**, because everything else stands
   on them. Every primitive takes a `Scheduler` (clock + timers), and the tests use a
   `VirtualScheduler`. The circuit breaker's property test waits out a 10-second cooldown in
   microseconds. Nothing in the suite sleeps.
3. **Mock providers and the `EnrichmentService`** that never throws for a provider failure.
4. **The pure scoring engine**, its evaluation context and ruleset v1, again with property
   tests. Each invariant in ADR-0015 became one `fc.property`.
5. **The two modules**: application use cases behind ports, Postgres adapters, subscribers,
   routes and metrics. Then integration tests against real Postgres, including a pipeline
   test that runs `alert.ingested → alert.enriched → alert.scored` through the real outbox
   relay.
6. **Docs**: seven ADRs (0040–0046), two module guides with exercises and _verified_
   solutions, contract and data-model updates.

## Bugs, and how I found them

### 1. A property test that hung (bulkhead)

- _Observation:_ the bulkhead property test timed out at 5 s. Every other test ran in milliseconds.
- _Hypothesis A:_ 300 runs × 25 calls is just slow. _Experiment:_ `numRuns: 3`.
  _Result:_ still hung. So it's a deadlock, not slowness.
- _Hypothesis B:_ fast-check's `s.waitAll()` returns once its queue is empty. But my
  "finish" tasks are scheduled _inside a `.then`_ that runs after an "arrive" task resolves.
  `waitAll` can see an empty queue in the gap between the two, return, and then
  `await Promise.all(calls)` waits forever for tasks nobody will release.
- _Experiment:_ replace it with `s.waitFor(Promise.all(calls))`, which keeps releasing
  tasks until the given promise settles. _Result:_ 300 runs in 94 ms.
- _Lesson:_ when a test controls the scheduler, "wait until idle" and "wait until done" are
  different questions. Ask the second one.

### 2. A stale event could overwrite a newer score (found by reasoning, before any test failed)

My first `saveIfChanged` was one elegant statement:
`INSERT … ON CONFLICT DO UPDATE … WHERE excluded is newer AND explanation differs`.
While writing its doc comment, I tried to describe what happens with three snapshots for
one alert, delivered as t1 (stored), t3 (identical score), then t2 (stale, different score):

- t3 is newer but identical, so the `WHERE` is false and **nothing** is updated, not
  even the snapshot time, which stays t1;
- t2 arrives: "newer than stored (t1)?" Yes. "Different?" Yes. **It overwrites the score.**

The fix splits it into insert-or-lock-and-compare (ADR-0042): a newer snapshot always
advances `source_occurred_at`, and the explanation is replaced only if it differs. The
integration test `scoring.test.ts › …ignores stale snapshots` replays exactly t1, t3, t3′, t2.
I hadn't run the buggy version against that test, so to make sure the test has teeth I
mutated the fixed code instead: removing the staleness check makes it fail, and making
"changed" always true makes two tests fail.
_Lesson:_ a doc comment that walks through a concrete sequence is a cheap model checker.
If you can't explain the edge case in prose, the code probably doesn't handle it.

### 3. Does the idempotency test actually test concurrency?

My first version of `enrichment.test.ts › is idempotent` delivered the event once,
_then_ fired two concurrent redeliveries. Re-reading it, I saw both would stop at the cheap
pre-check (`wasProcessed`), so the inbox's primary key, the part that matters under
concurrency, was never exercised. I rewrote it to fire three concurrent deliveries of a
**fresh** event, then mutated `markProcessed` to always return true.
_Result:_ the test failed with **2** `alert.enriched` events, not the 3 I expected.
_Hypothesis:_ the test pool has 5 connections, and the third delivery's pre-check query ran
after one of the others had committed. _Consistent with that:_ `Promise.all` resolved
(no error), so no handler failed; one simply took the pre-check exit. The real code
produces exactly 1 whatever the timing, and that is what the test asserts.
_Lesson:_ mutation-test your concurrency tests. A test that passes for the wrong reason
looks exactly like a test that passes for the right one.

### 4. A dangling `$ref` in the OpenAPI document

- _Observation:_ after `pnpm openapi:generate`, `GET /scoring/ruleset`'s schema contained
  `{"$ref": "#/components/schemas/schema0"}`, but `components.schemas` was empty.
- _Hypothesis:_ the recursive `ConditionSchema` (`z.lazy`) can't be inlined, so Zod emits
  a `$defs` entry, and something rewrites it into a component reference without emitting the component.
- _Experiment:_ read `fastify-type-provider-zod`'s `zod-to-json.js`. Refs are indeed
  rewritten to `#/components/schemas/<id>`, but components are only produced by
  `jsonSchemaTransformObject`, from schemas registered with an `id`.
- _Fix:_ `.meta({ id: 'Condition' })` on `ConditionSchema` and `transformObject:
jsonSchemaTransformObject` in `server.ts`. A small script checked that every `$ref` in
  the document now resolves. This will also matter for the playbooks workstream, whose
  definitions contain conditions.

### 5. Smaller ones

- **The lint-staged hook rejected my first commit.** `vitest.config.ts` is ESLint-ignored,
  and ESLint _warns_ about explicitly passed ignored files; `--max-warnings=0` turns that
  into a failure. I added `--no-warn-ignored`. Then my fix commit accidentally swept in
  everything I had staged earlier. `git show --stat` caught it before pushing, and a
  `reset --soft` split it properly. _Lesson:_ always look at `--stat` before pushing.
- **`no-unnecessary-condition` versus closures.** In a test, `let invoked = false` was
  set inside a callback. TypeScript's narrowing doesn't see writes made in closures, so the
  linter called the later `if (invoked)` "always false". An object (`probe.invoked`) fixed it.
- **A coverage gap that was dead code.** `evaluation-context.ts` had 82 % branch
  coverage. One uncovered branch was the "equal" case of a sort comparator that runs after
  a `Set`, so it can never happen. I removed the branch rather than contort a test to reach it.
- **A test that would have been flaky.** The "breaker opens" integration test runs six
  lookups. With `ENRICHMENT_CONCURRENCY` at 8 they all start before any fails, so the
  breaker sees six failures at once and no call is ever `circuit_open`. I set the
  concurrency to 1 in that test before running it.

## Surprises

- `node-postgres` parses the timestamp `-infinity` (my column default) as the **number**
  `-Infinity`, not a `Date`. Calling `.getTime()` on it would throw, hence a tiny `toMillis` helper.
- jsonb equality ignores key order. That makes "has the explanation changed?" a one-line SQL
  expression: `(explanation - 'computedAt') = (new - 'computedAt')`.
- fast-check's `fc.scheduler()` is the right tool for "under any interleaving" properties.
  It found nothing wrong in the bulkhead, but it found my misuse of it (bug 1).

## Decisions worth a second look later

- Breaker state is per process (ADR-0044). `GET /enrichment/providers` on the API shows
  only the API's breakers. The worker's are visible only through the metrics gauge.
- The inbox table grows forever until someone adds the purge sketched in exercise 5 of
  the enrichment guide.
- `POST /alerts/:id/enrich` answers 404 until the alerts module is wired in
  (`// INTEGRATION` in `composition.ts`).

## What I'd tell a junior engineer from this session

- Put time behind an interface on day one. Every resilience test here is deterministic
  because `Date.now()` and `setTimeout` are never called directly.
- Property tests are ADR sentences you can execute. "Adding a positive rule never lowers
  the score" is both documentation and a test.
- For every concurrency guard, ask: which test fails if I delete this line? Then delete it
  and check.
