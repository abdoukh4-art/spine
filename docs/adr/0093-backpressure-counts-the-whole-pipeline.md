# ADR-0093: Back-pressure counts the whole pipeline, caps concurrency, and the edge never fakes a 503

- **Status:** accepted (refines [ADR-0024](0024-api-conventions.md), [ADR-0034](0034-ingest-backpressure-implementation.md), [ADR-0082](0082-nginx-edge-proxy.md))
- **Date:** 2026-10-29
- **Deciders:** maintainers
- **Tags:** ops, architecture

## Context and problem statement

The first load test (2026-10-28) reported that "back-pressure works": at 200 alerts/s, 0.4 % of
requests got `503 + Retry-After`. The second load-test session (2026-10-29), which went past
200/s and kept nginx's and the API's logs, showed that conclusion was wrong in three ways
([performance.md](../operations/performance.md), runs 5–15):

1. **The 503s weren't Spine's.** nginx capped each client IP at 50 concurrent connections
   (`limit_conn`), and `limit_conn` answers **503** by default. All k6 traffic comes from one IP, so
   the edge shed load with the same status code as Spine's back-pressure. At 400/s nginx logged
   27 440 "limiting connections" errors while the API shed nothing.
2. **Spine's back-pressure watched the wrong buffer.** The guard counted undispatched outbox
   rows. The relay moves events into Redis within milliseconds, so the outbox stayed under 40
   while the BullMQ event queue reached **29 286 waiting jobs**. Under sustained overload Redis
   would fill again: the failure of the first load test, only slower.
3. **Saturation looked like bugs.** With the nginx cap raised, the API at 250–400/s queued
   requests for a database connection (pool of 10). Accepted p95 rose to **10–15 s**, and requests
   that waited more than 5 s failed with **500** ("timeout exceeded when trying to connect"):
   18 %, 31 % and 52 % of all requests at 250, 300 and 400/s. In an earlier 400/s run nginx had also
   run out of `worker_connections` (1024) and produced its own 500s. And every shed request was
   logged at `error` level with a stack trace, costing CPU exactly when there was none to spare.

## Decision drivers

- Under overload, accepted requests keep their latency, and the rest learn **at once** to back off.
- A status code must mean one thing: `503` = Spine shedding load, `429` = a client limit, `500` = a bug.
- Every buffer is bounded and visible (outbox, queue, in-flight requests).
- Shedding is cheap: no stack traces, no DB round trip for a rejected request.

## Considered options

1. **Measure the whole pipeline + cap ingest concurrency + map pool exhaustion to 503 + make nginx's limits 429 and configurable.**
2. Count the queue only in the worker and publish a "healthy" flag in Redis for the API.
3. Raise the database pool size and `worker_connections` until the errors stop.
4. A token-bucket rate limit on total ingest (alerts/s) instead of measuring.

## Decision outcome

**Option 1:**

- **Backlog = outbox + queued deliveries.** `pipelineBacklogProbe` adds BullMQ's
  `waiting + prioritized + delayed` counts for the event queue to the outbox count.
  `INGEST_MAX_BACKLOG` (unchanged default, 10 000) now means pending _deliveries_. If Redis can't
  be queried, the queue counts as 0 (fail open, like the rate limiter in ADR-0090; readiness
  already reports Redis down).
- **In-flight cap.** `INGEST_MAX_IN_FLIGHT` (default 16, chosen by measurement: see below) concurrent ingest requests per API process.
  The next one gets `503 + Retry-After: 1` in the `onRequest` hook, before the body is read, and the
  slot is released on the response's `close` event (sent or aborted, never leaked).
- **Pool exhaustion → 503.** node-postgres' acquire timeout maps to `503 overloaded` with
  `Retry-After: 5`, not 500.
- **Shedding is logged as a warning without a stack** (`request shed`).
- **nginx:** `limit_conn_status 429`; the per-IP cap is `SPINE_CONN_PER_CLIENT` (default 50);
  `worker_connections 4096` (each proxied request holds two connections).

Option 2 adds a moving part and a staleness window for no gain over a 1 s cached probe. Option 3
moves the knee but keeps the cliff: past any pool size, latency grows without bound. Option 4
needs a capacity number that changes with hardware, payloads and enrichment latency; measuring
the backlog adapts by itself.

**Measured** (same 4-core host, k6 open model through nginx, 1-minute ramp + 2-minute hold; details in
[performance.md](../operations/performance.md)):

| Offered load | Before: accepted p95 | Before: errors | After (cap 32): p95 / errors | After (cap 16): p95 / errors |
| ------------ | -------------------- | -------------- | ---------------------------- | ---------------------------- |
| 250/s        | 9.92 s               | 18.5 %         | 630 ms / 0 %                 | **354 ms / 0 %**             |
| 400/s        | 14.69 s              | 52.1 %         | 2.29 s / 2.8 %               | **800 ms / 0.95 %**          |

Throughput didn't change: the same ~13.8 k alerts were accepted at 250/s with either cap. A lower cap
only removes waiting (Little's law), so the default is 16. The errors left at 400/s are nginx failing
to connect to an API process that has no CPU left (k6, nginx, API, worker and Postgres share 4 cores).

### Consequences

- 👍 Overload degrades gracefully instead of collapsing (see "after" runs in performance.md).
- 👍 Load-test numbers mean what they say: a 503 is Spine's own back-pressure.
- 👎 Two more settings to tune (`INGEST_MAX_IN_FLIGHT`, `SPINE_CONN_PER_CLIENT`).
- 👎 The in-flight cap is per process: N API replicas allow N × 16.
- ⚖️ The probe makes one Redis call per second per API process.

## What would make us revisit this

- Several API replicas behind a load balancer → an adaptive limit (e.g. gradient/AIMD on latency) instead of a fixed cap.
- `INGEST_MAX_IN_FLIGHT` shedding at moderate load on bigger hosts → derive it from the pool size.
- Queue-length counting becoming expensive → have the relay maintain a counter.

## Further reading

- Little's law; Google SRE Book, ch. 21 _Handling Overload_ and ch. 22 _Addressing Cascading Failures_
- Netflix, _Performance Under Load_ (concurrency-limits, 2018)
- nginx docs: `limit_conn_status`, `worker_connections`
