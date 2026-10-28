# 2026-10-28 — Playbooks: a durable execution engine and its host

## Goal of the session

Build `packages/playbook-engine` (DSL validation + event-sourced, crash-safe execution) and
the `playbooks` module that hosts it: Postgres run store, BullMQ worker, approvals,
simulated response actions, HTTP API, and three real playbooks. Target behaviour: sequence
§2 in `docs/architecture/sequences.md`. The worker may crash anywhere and the run must
continue without repeating a completed action.

## What I did, in order, and why

1. **Read before typing.** Vision, the ADRs on events (0009, 0010), the DSL (0013),
   simulated adapters (0018), the contracts, and the platform kernel. Two things I learnt
   there shaped everything: the queue is _not_ the source of truth (ADR-0008), and every
   cross-module workflow goes through the outbox (ADR-0009).
2. **Designed the engine as three functions** (ADR-0050): `reduce` (events → state),
   `decide` (state → next action) and `advance` (act through ports, append, loop). The
   first two are pure, so "what happens after a crash at line N?" becomes a unit test.
3. **Chose attempt-scoped idempotency keys**, `${runId}:${stepId}:${attempt}`. The
   sequence diagram said `runId:block`. I changed it because of a subtle case: if a retry
   after a _failure_ reused the key, a real, well-behaved API would replay the cached
   failure forever. Crash re-execution keeps the attempt number, so it keeps the key. I
   updated the diagram in the same PR.
4. **Wrote the property tests early.** Random DAG generator (forward-only edges plus an
   `i → i+1` spine guarantee acyclic and connected), plus an independent "oracle" walker
   that computes the expected path.
5. **Hosted it in the API**: Postgres `RunStore` with the projection and outbox inside the
   append transaction (ADR-0055), BullMQ jobs that carry only `{runId}` (ADR-0051), step
   handlers behind ports, and simulated integrations keyed by the idempotency key.
6. **Integration tests against real Postgres and Redis**, including a forced race of two
   workers inside the same step.

## Bugs and surprises (hypothesis → experiment → result)

- **The first commit was rejected by the pre-commit hook.** _Observation:_ ESLint warned
  "File ignored because of a matching ignore pattern" for `vitest.config.ts`, and
  `--max-warnings=0` turned that into a failure. _Hypothesis:_ lint-staged passes every
  staged `.ts` file, including ones the ESLint config ignores. _Experiment:_ add
  `--no-warn-ignored` to the lint-staged command. _Result:_ the hook passes and real
  problems are still reported. I changed the root `package.json` (a one-flag fix every
  workstream benefits from) instead of bypassing hooks.
- **`!!binary` survived the "safe" YAML schema.** I expected `schema: 'core'` with no
  custom tags to refuse non-JSON values. _Experiment:_ parse `d: !!binary aGVsbG8=` and
  print the result. _Result:_ a Buffer. Fix: walk the document and reject _any_ explicit
  tag (ADR-0054). Lesson: test your security assumptions about libraries, don't infer
  them from option names.
- **`maxAliasCount: 1` threw on a single alias.** The limit counts expansions, not
  anchors, and nesting multiplies them. I picked 50 and wrote a billion-laughs test.
- **A bug I caught by reading, not by a test.** My first executor draft appended
  `step.started`, then built the result append from the _same_ captured `lastSeq`. The
  second append would have conflicted with the first and looped forever on "concurrency
  errors". I rewrote appends as a small `Appender` that advances its own sequence number.
  It's a reminder that "optimistic concurrency" turns an off-by-one into a livelock, not a crash.
- **All property tests passed on the first run, which made me suspicious.** A property that
  can't fail is worse than none. _Experiment:_ inject two bugs on purpose: resume a crashed
  step with `attempt + 1`, and drop the `.reverse()` in compensation ordering. _Result:_ the
  crash-resume and compensation-order properties failed immediately, with shrunk
  counter-examples. Then I reverted. This is cheap mutation testing; do it for every property.
- **Keyset pagination and microseconds.** `created_at DEFAULT now()` stores microseconds,
  but cursors carry millisecond ISO strings. Rows created in the same millisecond could be
  skipped or repeated. Fix: write `created_at`/`requested_at` explicitly from the injected
  clock (millisecond precision). TypeScript then pointed out that Kysely wanted `Date`
  operands for comparisons. Fair.
- **Parallel test files sharing one BullMQ queue.** Each integration file has its own
  Postgres schema, but Redis is shared, so a worker in file A could steal file B's jobs
  (and report "run not found"). Fix: a per-file BullMQ key prefix.
- **A stall I found by reasoning, and only fixed by reasoning.** A delayed retry job that
  wakes a few milliseconds early (clock skew) sees "not yet", and schedules the same delayed
  job again. With the same job ID BullMQ drops the add, because the job is still active
  under that ID, so the run would stall until the next restart. Delayed job IDs now include
  the scheduling time. _Honest note:_ there's no automated test for this one. Simulating
  clock skew between BullMQ and the engine needs a fake clock inside BullMQ.
- **Hyphenated step IDs can't be referenced in templates.** Step IDs are kebab-case, but
  path segments only allow `[A-Za-z0-9_]`, so `{{steps.block-source.output}}` renders
  nothing. I renamed the step, documented the limitation (ADR-0053) and turned it into an
  exercise rather than changing the shared path grammar under five other workstreams.
- **My own test was wrong once.** The phishing happy path took the "suspicious" branch
  because the fixture's domain was suspicious. The code was right. Read the timeline before
  you "fix" the engine.

## Decisions written down

ADR-0050 (engine shape and keys), 0051 (BullMQ hosting, job IDs, reconciler, sweeper),
0052 (dry-run, cancel, timeouts), 0053 (snapshot + enrichment summary), 0054 (locked-down
parsing), 0055 (projection and outbox inside the append).

## What I'd tell a junior engineer from this session

- Make the "what next?" logic a pure function of stored facts. Then crash recovery is the
  normal code path, not a special case nobody tests.
- Record _intent_ before a side effect and _outcome_ after it, and give the side effect a
  key that is stable across retries of the same attempt. That's most of durable execution.
- When a property test passes immediately, break the code on purpose and watch it fail.
