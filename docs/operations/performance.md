# Performance

> **Status:** measured on 2026-10-28 (runs 1–4) and 2026-10-29 (runs 5–15 and a 30-minute soak)
> against the integrated stack. Run 2's back-pressure conclusion turned out to be wrong; the
> correction and what it led to are in [Results (2026-10-29)](#results-2026-10-29).

## Questions the load test answers

1. **Capacity:** how many alerts per second can one API + one worker accept while meeting
   the ingest latency target (p95 < 500 ms for `POST /api/v1/alerts`)?
2. **Pipeline lag:** at that rate, does ingest → scored stay under 2 s p95 (SLO 2,
   [slos.md](slos.md)), or does the outbox backlog grow?
3. **Graceful degradation:** above capacity, does Spine shed load with `503`
   back-pressure (by design, ADR-0024) instead of timing out or falling over?
4. **The bottleneck:** which resource saturates first: API event loop, DB pool, Postgres
   CPU/IO, Redis, or the worker's handlers?

## Method

**Tool:** [k6](https://k6.io), run in Docker by `scripts/load-test.sh` against the Compose
stack, through nginx (`http://localhost:8080`), so the edge is part of the measurement.
Script: `load/ingest.js`.

**Workload model: open, not closed.** The `ramping-arrival-rate` executor starts
requests at a fixed rate whether or not earlier ones have finished, like independent
sensors. A closed model (N users in a loop) waits for slow responses before sending
more, so it slows down exactly when the server does and under-reports latency
("coordinated omission").

**Traffic shape:** ramp from `PEAK_RATE/10` to `PEAK_RATE` over `RAMP` (1 min), hold for
`HOLD` (3 min), ramp down. Each request is a realistic canonical alert (ADR-0011): one of
seven ATT&CK-mapped categories, mixed severities, RFC 5737 documentation IPs, three
indicators. `DUPLICATE_RATIO` (10 %) re-sends an earlier `sourceAlertId` to exercise
deduplication, and every request carries a unique `Idempotency-Key`.

**Outcome classes** (counted separately, never lumped into "errors"):

| Status | Meaning                                  | Metric                                       | Threshold                                   |
| ------ | ---------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| 202    | accepted (created/deduplicated)          | `spine_accepted_duration`                    | p95 < 500 ms, p99 < 1.5 s                   |
| 503    | back-pressure (system protecting itself) | `spine_backpressure_503` (count)             | reported, no threshold                      |
| 429    | per-client rate limit hit                | `spine_rate_limited`                         | rate < 1 % (else the test is misconfigured) |
| other  | genuine error                            | `http_req_failed`, `spine_unexpected_status` | rate < 1 %                                  |

**Procedure**

1. `make up`; set `RATE_LIMIT_MAX_PER_MINUTE` high enough (all k6 traffic comes from one
   IP) and keep the rest of `.env` at production-like values (`LOG_LEVEL=info`).
2. Get a token (`SPINE_TOKEN`), or let the script log in (default: `BOOTSTRAP_ADMIN_*` from `.env`)
   or as `SPINE_EMAIL`/`SPINE_PASSWORD` (the demo analyst once Phase 2 seeds it).
3. Find the knee: run with `PEAK_RATE` = 50, 100, 200, 400 … (`HOLD=3m` each, with a pause
   in between so the backlog drains). The knee is the highest rate where p95 < 500 ms,
   errors < 1 % and the outbox backlog stays flat.
4. Soak at 70 % of the knee for 30 minutes to catch leaks (RSS, heap, DB pool, backlog).
5. During every run, watch Grafana: RED panel, event-loop delay, DB pool, queue depth,
   outbox backlog. Record the Prometheus queries' values next to k6's summary.
6. Record hardware (CPU model and cores, RAM, disk), versions (git SHA, image tags) and
   all non-default settings with the results. A number without its context is meaningless.

```bash
./scripts/load-test.sh --inspect                 # validate the script (no traffic)
SPINE_TOKEN=… PEAK_RATE=100 ./scripts/load-test.sh
```

k6 writes its summary to `load/results/ingest-<timestamp>.json` (git-ignored; copy the
interesting numbers here).

## Results (2026-10-28)

**Environment:** one host, 4 vCPU Intel Xeon @ 2.80 GHz, 15 GB RAM; the whole Compose stack
(nginx, API, worker, Postgres 16, Redis 7 with `maxmemory 200mb`, Prometheus, Grafana) plus
k6 on the same machine. That means k6, API, worker and Postgres compete for the same 4 cores, so treat
the numbers as a lower bound. Mock enrichment latency `ENRICHMENT_LATENCY_MS=30`,
`EVENT_WORKER_CONCURRENCY=8`, `LOG_LEVEL=info`. Ingest-to-scored latency is measured in SQL as
`alert_scores.computed_at − alerts.received_at`.

| Run | Load                 | Code / settings                                                  | Accepted p95 / p99 | Errors                  | 429  | 503 (shed)  | Ingest → scored                             |
| --- | -------------------- | ---------------------------------------------------------------- | ------------------ | ----------------------- | ---- | ----------- | ------------------------------------------- |
| 1   | 200/s, 2 min plateau | first integrated build                                           | 177 / 245 ms       | **1 904 × 500 (6.3 %)** | 34 % | 47          | not measured                                |
| 2   | 200/s, 2 min plateau | ADR-0090 retention + fail-open, ingest limit raised for the test | **167 / 269 ms**   | **0**                   | 0    | 122 (0.4 %) | p95 **129 s** (pipeline lags; see below)    |
| 3   | 20/s, 2 min          | poll interval 200 ms                                             | 17 / 23 ms         | 0                       | 0    | 0           | p50 355 ms · **p95 1 011 ms** · p99 8.7 s   |
| 4   | 20/s, 2 min          | **poll interval 50 ms** (new default)                            | 15 / 22 ms         | 0                       | 0    | 0           | p50 **98 ms** · **p95 125 ms** · p99 269 ms |

### What we learned

1. **Run 1 → 2: Redis OOM turned into 500s.** Completed BullMQ jobs (each with a full alert
   snapshot) were kept 24 h / 100 k, and the rate limiter failed closed when Redis errored.
   Both are fixed (ADR-0090). Redis peaked at 130 MB during run 2. The 429s in run 1 were the
   ingestion limit (6 000/min per client IP) doing its job, since all k6 traffic comes from one
   IP; it's now configurable (`INGEST_RATE_LIMIT_PER_MINUTE`).
2. **Ingestion capacity ≥ 200 alerts/s** through nginx with p95 167 ms (target < 500 ms).
   ~~Back-pressure works: when the outbox backlog crossed `INGEST_MAX_BACKLOG`, 0.4 % of requests
   got `503`~~ **Wrong, corrected on 2026-10-29:** those 503s came from nginx's per-IP connection
   cap, not from Spine, and the 50-connection cap also quietly limited the API's concurrency. See
   below.
3. **The async pipeline is the bottleneck under sustained load.** During run 2 it processed
   ≈ 45 alerts/s; after the load stopped it drained at ≈ 250 alerts/s (29 k alerts cleared in
   ≈ 5 min). The difference is CPU contention on a single 4-core host, not a design limit. Scale
   the worker onto its own host, then raise `EVENT_WORKER_CONCURRENCY`.
4. **Latency at realistic load** (20 alerts/s, already more than many SOCs see): two outbox
   hops × up to 200 ms of polling gave p95 1 s. At 50 ms polling, p95 is **125 ms**, which meets
   vision S2 (< 500 ms) and SLO 2 (< 2 s).

## Results (2026-10-29)

Same host and settings as above, except: `RATE_LIMIT_MAX_PER_MINUTE` and
`INGEST_RATE_LIMIT_PER_MINUTE` set to 1 000 000 (all traffic comes from one IP), 1-minute ramp +
2-minute hold per run, and a sampler recording the backlog, BullMQ queue depth, RSS, heap,
event-loop delay, Redis memory and Postgres connections every 15 s. Each run starts with an empty
queue. "Accepted" = 202; "shed" = 503 from Spine; "errors" = anything else.

| Run | Offered | Code / settings                                                   | Accepted | Accepted p95 | Shed (503) | Errors              |
| --- | ------- | ----------------------------------------------------------------- | -------- | ------------ | ---------- | ------------------- |
| 5   | 400/s   | v0.1 code, nginx `limit_conn 50`                                  | 30 250   | 445 ms       | 36 950 ¹   | 0                   |
| 6   | 400/s   | pipeline backlog probe, nginx cap 4000, `worker_connections` 1024 | 13 882   | 11.46 s      | 21 824     | **17 755 (33 %)** ² |
| 7   | 100/s   | + `worker_connections` 4096, shedding logged as warn              | 14 686   | 142 ms       | 2 114      | 0                   |
| 8   | 250/s   | same                                                              | 12 445   | 9.92 s       | 17 662     | 6 845 (18.5 %) ³    |
| 9   | 300/s   | same                                                              | 13 285   | 10.66 s      | 14 485     | 12 415 (30.9 %) ³   |
| 10  | 400/s   | same                                                              | 14 404   | 14.69 s      | 8 204      | 24 590 (52.1 %) ³   |
| 11  | 150/s   | + in-flight cap 32, pool exhaustion → 503                         | 12 254   | 374 ms       | 12 946     | 0                   |
| 12  | 250/s   | same                                                              | 13 645   | 630 ms       | 28 355     | 0                   |
| 13  | 400/s   | same                                                              | 7 312    | 2.29 s       | 56 576     | 1 822 (2.8 %) ⁴     |
| 14  | 250/s   | **in-flight cap 16** (new default)                                | 13 842   | **354 ms**   | 28 158     | **0**               |
| 15  | 400/s   | same                                                              | 8 390    | 800 ms       | 56 773     | 628 (0.95 %) ⁴      |

¹ All from nginx: `limit_conn` answers 503 by default (27 440 "limiting connections" log lines;
the API shed nothing). ² nginx 500s ("1024 worker_connections are not enough") and 502/504.
³ API 500s: requests waited > 5 s for one of 10 pooled DB connections ("timeout exceeded when
trying to connect"). ⁴ nginx 504/502: it couldn't connect to an API process with no CPU left.

### What we learned (2026-10-29)

1. **Run 5 looked healthy for the wrong reason.** nginx's 50-connection cap per IP acted as an
   accidental concurrency limit and produced every 503. Meanwhile Spine's back-pressure counted the
   outbox (max 40) while the BullMQ queue held **29 286** waiting jobs, so the real buffer was
   unbounded. Fixes in [ADR-0093](../adr/0093-backpressure-counts-the-whole-pipeline.md): the probe
   counts outbox + queue, and nginx answers **429** for its own limits.
2. **Without a concurrency limit, overload collapses** (runs 8–10): requests queue for a DB
   connection, p95 reaches 10–15 s, and timeouts surface as 500s.
3. **A per-process in-flight cap fixes it** (runs 11–15): 0 errors up to 250/s offered, and
   accepted p95 stays under 500 ms. Halving the cap from 32 to 16 cut p95 from 630 to 354 ms with
   the **same** throughput (13.6 k vs 13.8 k accepted). That's Little's law: fewer requests in
   flight at the same rate means less waiting. 16 is the default.
4. **The sustainable rate is the pipeline's, ≈ 42–45 alerts/s on this shared host** (scored
   rows per second during runs 7, 12 and 14). Above it, back-pressure sheds the excess (51–86 %
   of requests at 150–400/s) so the backlog stays bounded. Bursts up to `INGEST_MAX_BACKLOG`
   pending deliveries are absorbed.
5. **Rejection isn't free.** At 400/s the host spends its CPU answering 503s, and goodput falls
   from ~13.8 k to ~8.4 k accepted. The remedy is more CPU (separate hosts), not more tuning.

**Vision S3** ("≥ 200 alerts/s sustained with back-pressure, no errors", single API instance):
**met at 250/s offered** (run 14: 0 errors, every request answered 202 or 503 + `Retry-After`,
accepted p95 354 ms). At 400/s, 0.95 % errors on this shared 4-core host.

### Soak (30 minutes at 30 alerts/s)

Webhook mode (HMAC-signed like a sensor, so no session expires), 30 alerts/s for 30 minutes
(≈ 70 % of the pipeline's measured capacity), final code (ADR-0093 + ADR-0095), sampled every 15 s.

| Measure                                         | Result                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Requests                                        | 55 439: **0 errors, 0 shed**                                                                 |
| Accepted latency                                | p95 **21 ms**, p99 42 ms, max 513 ms                                                         |
| Pipeline                                        | kept up: 53 983 alerts ingested, 53 984 scored; backlog ≤ 19 outbox events, ≤ 22 queued jobs |
| Heap, API / worker (first 10 → last 10 samples) | 49 → 51 MB / 47 → 50 MB (max 55 / 57 MB)                                                     |
| RSS, API / worker                               | 132 → 138 MB / 124 → 133 MB                                                                  |
| Redis memory                                    | 40–41 MB, flat                                                                               |
| Postgres connections                            | 10–21                                                                                        |

**No leak found:** heap and Redis are flat. RSS rose 6–9 MB over 30 minutes, which is typical of
Node reaching its steady state; a multi-hour soak would show whether it plateaus.

**Two failed attempts first, both instructive.** (1) The first soak used the API's bearer token,
and every request after minute 15 got `401`: the access token expired (`AUTH_ACCESS_TTL_SECONDS` =
900). That's a property of the load generator, not of Spine, so soaks now use `MODE=webhook`.
(2) That same soak, on the code before ADR-0095, showed the worker's heap jumping from ~50 MB to
~150 MB on each 30-second gauge refresh, because the gauges loaded every alert of the last 24 h
(177 k after the sweeps) into memory. It wasn't a leak (the heap came back down), but the cost
grew with volume. The fix moved the aggregation into Postgres
([ADR-0095](../adr/0095-aggregate-metrics-in-the-database.md)): `GET /metrics/summary` over those
177 k alerts now takes 0.49 s, and the heap stayed flat in the soak above.

### Not measured (and why)

- **Separate hosts** for the API, worker and Postgres. This build environment is one machine, so
  every number above includes CPU contention between k6, nginx, the API, the worker and Postgres. The
  procedure is the same: point `BASE_URL` at the edge and run the sweep from a separate load host.
- **Playbook throughput under load** in isolation (runs are triggered by the scored alerts in every
  run above, but approval-gated steps are human-paced).
