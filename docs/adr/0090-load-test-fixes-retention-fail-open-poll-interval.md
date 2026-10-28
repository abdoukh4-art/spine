# ADR-0090: Bounded job retention, fail-open rate limiting and a 50 ms outbox poll (from the first load test)

- **Status:** accepted (refines [ADR-0008](0008-bullmq-redis-job-queue.md), [ADR-0009](0009-domain-events-transactional-outbox.md), [ADR-0024](0024-api-conventions.md))
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** ops, architecture

## Context and problem statement

The first k6 run against the integrated stack (200 alerts/s, results in
[performance.md](../operations/performance.md)) exposed three problems that no unit or
integration test could have shown:

1. **Redis ran out of memory** (`OOM command not allowed when used memory > 'maxmemory'`).
   Completed event-delivery jobs were kept for 24 h / 100 000 per queue, and each one carries a
   full alert snapshot (ADR-0009's "payloads carry snapshots"). 30 k alerts × 4 subscribers filled
   the 200 MB container.
2. **That Redis error became 1 904 HTTP 500s.** The rate limiter's Redis store threw, and the
   limiter failed the request. A protection mechanism took ingestion down.
3. **Ingest → scored latency missed its target** even at a modest 20 alerts/s: p95 1 011 ms
   against S2's < 500 ms. Each alert crosses the outbox twice (ingested → enriched → scored),
   and each hop waited up to one 200 ms poll interval.

## Decision drivers

- Availability of ingestion first (goal G4).
- Bounded memory for every buffer.
- Measured, not guessed: each change is tied to an experiment.

## Considered options

- Retention: **(a) 1 h / 10 k completed jobs** · (b) remove on completion (no dedup window) · (c) slim job payloads to IDs only.
- Rate-limit store failure: **(a) fail open (`skipOnError`) + log** · (b) fail closed (500/503) · (c) in-memory fallback store.
- Latency: **(a) poll every 50 ms** · (b) Postgres `LISTEN/NOTIFY` wake-ups with polling as fallback · (c) accept the 1 s p95.

## Decision outcome

**Retention (a).** A completed job ID only has to outlive a relay crash between `addBulk` and the
`dispatched_at` commit, which takes seconds. One hour is generous. Removing on completion (b)
would lose the dedup window entirely. Slim payloads (c) are the better long-term fix but change the
event contract, so they're listed in "revisit".

**Fail open (a).** Rate limiting protects availability, so turning a store outage into a total
outage defeats its purpose. During a Redis outage there is no throttling, and that is logged.
The login limiter already had its own in-memory fallback (ADR-0063), so credential stuffing
still meets a limit.

**50 ms poll (a).** _Experiment:_ same 20 alerts/s load, poll interval 200 → 50 ms.
_Result:_ ingest → scored p95 1 011 ms → **125 ms** (p50 355 → 98 ms), worker CPU about 4 %.
The cost is 20 cheap index-only queries per second on an idle system (the partial index
`domain_events_undispatched_idx`). `LISTEN/NOTIFY` (b) would get to ~0 ms of waiting, but it adds
a dedicated connection and reconnection handling. That's worth it later, not now.

### Consequences

- 👍 Under 200 alerts/s: 0 errors, Redis peak 130 MB of 200 MB, accepted p95 167 ms.
- 👍 S2 met at 20 alerts/s (p95 125 ms).
- 👎 More idle DB queries (20/s per worker).
- 👎 A Redis outage disables global rate limiting until it recovers (logged).
- ⚖️ At 200 alerts/s the _async_ pipeline still lags on a 4-core box (≈ 45 alerts/s while the
  API is under load, ≈ 250 alerts/s once it isn't). That's CPU contention on one host, documented in
  performance.md, not solved here.

## What would make us revisit this

- Redis memory > 70 % in steady state → slim job payloads to `{eventId}` and load the event from the outbox.
- Idle poll queries visible in DB load → `LISTEN/NOTIFY` wake-ups.
- Need for > 100 alerts/s sustained end-to-end → separate worker host(s), and scale `EVENT_WORKER_CONCURRENCY`.

## Further reading

- BullMQ docs, _Auto-removal of jobs_; @fastify/rate-limit, `skipOnError`
- Google SRE Book, ch. 22 _Addressing Cascading Failures_
