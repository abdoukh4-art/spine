# ADR-0034: Back-pressure checks a cached outbox backlog in `onRequest`

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** ingestion workstream
- **Tags:** architecture, ops

## Context and problem statement

[ADR-0024](0024-api-conventions.md) decides _that_ ingestion sheds load with `503` +
`Retry-After: 5` when the outbox backlog exceeds `INGEST_MAX_BACKLOG`. Measuring the backlog
is a `COUNT(*)` over the undispatched rows (a partial index keeps it small, but it is still a
query). At the 200 alerts/s target ([vision S3](../00-vision.md)), counting on every request
would add 200 queries/s whose answer barely changes between them.

## Decision drivers

- Cheap: the check must cost far less than the work it protects.
- Early: reject before body parsing (up to 10 MiB for batches) and before the transaction.
- Honest readiness: `/readyz` must report the same condition.

## Considered options

1. **Per-process cache of the backlog for ~1 s, single-flight refresh, checked in a route `onRequest` hook**
2. Count on every request
3. Have the worker publish the backlog to Redis; the API reads it
4. A token bucket on ingest rate instead of measuring the backlog

## Decision outcome

**Option 1.** `BackpressureGuard` (ingestion/application) wraps a `BacklogProbe` port
(`outboxBacklog(db)` from the platform). It caches the value for 1 s using the injected `Clock`;
concurrent callers during a refresh share **one** in-flight query (no thundering herd when the
cache expires); a failed probe is not cached. Each ingestion route runs `guard.check()` in
`onRequest`, which throws `OverloadedError` → `503`, `Retry-After: 5`,
`problem type …/overloaded`, and increments `spine_ingest_backpressure_rejections`. The module
also contributes the readiness check `ingest-backlog` (`backlog <= INGEST_MAX_BACKLOG`).

### Consequences

- 👍 At most one COUNT per second per API process, whatever the request rate.
- 👍 Overloaded clients are turned away before their body is read.
- 👎 Up to ~1 s of staleness: a burst can overshoot the threshold by one second of traffic. The
  threshold is a soft limit by nature, so this is acceptable.
- ⚖️ Hook order: the global access-control hook also runs in `onRequest`
  ([ADR-0067](0067-authorize-before-body-parsing.md)) and root hooks run before route hooks, so
  callers are authenticated (or HMAC routes skipped) first, then shed. Anonymous callers get
  `401`, not `503`; the cost is one cached token check per shed request, which is cheap.

## Pros and cons of the options

### Count on every request

- 👍 Exact.
- 👎 Doubles the DB round trips of ingestion for no practical benefit.

### Backlog in Redis

- 👍 One measurement shared by all API instances.
- 👎 A second source of truth that can go stale if the worker dies, which is exactly when
  back-pressure matters most.

### Rate limiting only

- 👍 Simple.
- 👎 Measures input, not the pipeline's health. A slow enrichment provider fills the backlog at
  normal input rates; only the backlog sees that.

## What would make us revisit this

- Many API replicas making the per-process cache multiply the COUNT load (switch to option 3).
- A need for per-source fairness during overload (shed the noisiest source first).

## Further reading

- Google, _Site Reliability Engineering_, ch. 21 "Handling Overload"
- Fred Hebert, _Queues Don't Fix Overload_ (2014, blog post)
