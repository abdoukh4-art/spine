# 2026-10-29: Closing the gaps, and finding out a "pass" was wrong

## Context

v0.1 shipped with four honest gaps in [STATUS](../STATUS.md): API coverage measured on unit tests
only, the audit-log database role (security finding F4), load tests that stopped at 200/s, and
doc comments nobody had counted. Closing them was meant to be routine. Two of the four overturned
something we had already written down as true.

## 1. Coverage: a gate that only existed in prose

ADR-0021 said "≥ 70 % for the whole API, CI fails below the threshold". I went to raise it and
found **no threshold configured at all**, for the API or its domain folders. The packages had
gates; the API's existed only as a sentence.

_Fix:_ one Vitest run over both projects (unit + integration) gives a naturally merged report:
**95.6 % lines**, against 60 % for unit tests alone, because adapters are tested against real
Postgres and Redis on purpose. Gates now exist, and I mutation-checked one: raising the domain
branch gate to 99 % made the run fail ([ADR-0091](../adr/0091-combined-unit-and-integration-coverage.md)).

**Lesson:** a rule written in an ADR is a hypothesis about your CI. Check it.

### The flaky test finally confessed

The first instrumented run failed the end-to-end test that had flaked twice before, this time with
output: `expected null to be 100` on `summary.score`. The score row and the queue's projection of
it are written by different outbox subscribers, and the test read the projection right after the
score appeared. Coverage instrumentation slowed things down just enough to lose the race. The
product was right (eventual consistency, by design); the test assumed read-your-writes. Details in
the [hardening journal](2026-10-28-hardening.md#postscript-2026-10-29-the-flaky-test-solved).

## 2. F4: test the attack, not the configuration

Separating the migration role from the runtime role ([ADR-0092](../adr/0092-separate-migration-and-runtime-database-roles.md))
is mostly plumbing: a one-shot `migrate` service, a `spine_runtime` group role, a startup check.
What made it trustworthy was writing each test as the attack itself:

```
update audit_log set action = 'forged' …         → permission denied for table audit_log
alter table audit_log disable trigger …          → must be owner of table audit_log
```

The first draft of the tests passed at once, so I removed the `REVOKE` from the migration: two tests
failed, which proved they test the privilege and not the trigger. I then ran the same attack with
`psql` against the live Compose stack, and ran a backup/restore drill to check that the GRANTs
survive `pg_dump` (they do; the roles themselves don't, and the doc now says so).

## 3. The load test: three layers of wrong

The plan was simple: push past 200/s to find the knee, then soak. At 400/s the run looked
excellent: 0 errors, p95 445 ms, 55 % of requests shed with `503`. Back-pressure working, as
recorded the day before.

_Observation that didn't fit:_ the outbox backlog metric never exceeded **40**, but the guard sheds
only above **10 000**. So who sent the 503s?

_Experiment:_ grep the edge's error log. **27 440 × `limiting connections by zone "spine_conn"`.**
nginx caps each client IP at 50 connections, and `limit_conn` answers 503 by default. Every k6
request comes from one IP. The edge was faking our back-pressure, and yesterday's 0.4 % "shed" was
probably the same thing.

Then the second layer: if the outbox stayed at 40, where was the work? In Redis. The relay moves
events into BullMQ within milliseconds, and the queue had **29 286** waiting jobs. Our
back-pressure watched an almost-empty buffer while the real one grew without bound, which is
the first load test's Redis OOM again, only slower.

I fixed both (count outbox + queue, make nginx answer 429), raised nginx's cap and re-ran. Third
layer: **the system collapsed.** At 250/s, accepted p95 was 9.9 s and 18 % of requests were 500s.
The 50-connection cap had been hiding it by acting as an accidental concurrency limit. Without it,
requests queued for one of 10 database connections, and those that waited 5 s failed.

_Fix:_ a deliberate concurrency limit (`INGEST_MAX_IN_FLIGHT`). Excess requests get `503` before
the body is read, and a pool timeout maps to 503 instead of 500. Results at 250/s: **0 errors, p95
630 ms**. Then one more experiment: cap 16 instead of 32. **p95 354 ms with the same
throughput.** That's Little's law: same arrival rate, fewer requests in flight, less time waiting.

Along the way: every shed request was logged at `error` level **with a stack trace**, which costs
CPU exactly when there is none, so shedding is now a warning without a stack. And nginx ran out of
`worker_connections` (1024), because each proxied request holds two connections.

Full table: [performance.md](../operations/performance.md#results-2026-10-29);
decision: [ADR-0093](../adr/0093-backpressure-counts-the-whole-pipeline.md).

## 4. The soak: two false starts and a real finding

**False start 1.** The first 30-minute soak reported 52.8 % errors. Every one was a `401`, and the
first came exactly 15 minutes in: the load generator logged in once, and the access token expired.
Spine was right and the test was wrong. Soaks now sign requests like a sensor (`MODE=webhook`), so
there's no session to expire.

**The real finding, in the same run.** The sampler showed the worker's heap jumping from ~50 MB
to ~150 MB every 30 seconds. _Hypothesis:_ a leak. _Check:_ the heap came back down to ~44 MB
between spikes, so it's not a leak but a periodic job. The 30-second job is the SOC gauge refresh,
and it loaded **every alert of the last 24 h** into Node to compute MTTD/MTTR. After the load tests,
that was 177 000 alerts. Memory grew linearly with alert volume, and at the pipeline's own
throughput it would have broken the 512 MB limit within a day.

_Fix_ ([ADR-0095](../adr/0095-aggregate-metrics-in-the-database.md)): aggregate in Postgres.
`percentile_disc` turns out to be exactly ADR-0026's nearest-rank definition. The interesting part
is keeping two implementations honest: the TypeScript functions stay as the **executable
specification**, and a differential property test inserts random alerts and runs into Postgres and
demands that SQL = TypeScript. It found a real difference on its first run: a mean of 3871.4045 s
rounds to .405 in Postgres (exact numeric, half away from zero) and to .404 in JavaScript (the
double is a hair below the tie). That's one millisecond, and the test now allows exactly that.

**False start 2.** I'd started the clean soak before rebuilding the stack, so it would have measured
the old code. I stopped it after 10 seconds, rebuilt, and started again. Then **0 errors in 55 439
requests, p95 21 ms, flat heap and Redis** ([performance.md](../operations/performance.md#soak-30-minutes-at-30-alertss)).

**And one CI failure I caused myself.** Lowering the in-flight default from 32 to 16 made CI fail
on a test that fires 20 concurrent ingests to provoke deduplication races: the new limit rightly
shed 4 of them. It passed locally only because I'd last run that file before changing the default.
A new limit changes the assumptions of tests that never mentioned it.

## 5. Doc comments: measure first

The v0.1 report said doc comments were "present on the main public interfaces". A 90-line script on
the TypeScript compiler API measured **50.4 %** of the public surface. The gaps were the Zod contracts,
whose meaning was obvious to whoever wrote them and to nobody else. Now 341/341, enforced in CI
([ADR-0094](../adr/0094-tsdoc-on-the-public-surface.md)). Writing them turned up one wrong route name
in my own first draft (`/audit` instead of `/audit-log`): the check proves a comment exists, not that
it's right.

## Things I'd tell a junior engineer

- **A green result you can't explain is not a result.** "0 errors" at 400/s on a 4-core box should have
  been suspicious, not reassuring.
- **One status code, one meaning.** If two layers can both send `503`, your dashboards can't tell
  "we're protecting ourselves" from "something in front of us is".
- **Find every buffer.** Back-pressure that measures the wrong queue is worse than none, because it
  makes you confident.
- **Hidden limits hide collapses.** Removing an accidental limit is a good way to discover you
  needed a deliberate one.
- **Re-read your own past conclusions** when new evidence shows up, and correct them in place
  (performance.md keeps yesterday's claim, struck through, next to the correction).
