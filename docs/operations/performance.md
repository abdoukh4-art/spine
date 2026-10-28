# Performance

> **Status:** measured on 2026-10-28 against the integrated stack (results below). The
> 30-minute soak and the "find the knee" sweep above 200/s have **not** been run yet.

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

## Results

_To be recorded in Phase 3._ Template:

| Date | Git SHA | Host | PEAK_RATE | Accepted p95 / p99 | Errors | 503s | Backlog trend | Bottleneck observed |
| ---- | ------- | ---- | --------- | ------------------ | ------ | ---- | ------------- | ------------------- |

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
2. **Ingestion capacity ≥ 200 alerts/s** through nginx with p95 167 ms (target < 500 ms), and
   back-pressure works: when the outbox backlog crossed `INGEST_MAX_BACKLOG`, 0.4 % of
   requests got `503 + Retry-After` instead of timing out (vision S3: met).
3. **The async pipeline is the bottleneck under sustained load.** During run 2 it processed
   ≈ 45 alerts/s; after the load stopped it drained at ≈ 250 alerts/s (29 k alerts cleared in
   ≈ 5 min). The difference is CPU contention on a single 4-core host, not a design limit. Scale
   the worker onto its own host, then raise `EVENT_WORKER_CONCURRENCY`.
4. **Latency at realistic load** (20 alerts/s, already more than many SOCs see): two outbox
   hops × up to 200 ms of polling gave p95 1 s. At 50 ms polling, p95 is **125 ms**, which meets
   vision S2 (< 500 ms) and SLO 2 (< 2 s).

### Not yet measured (honest gaps)

- The knee above 200/s (400/s and up), and the 30-minute soak (memory leaks, DB pool).
- Playbook throughput under load (approval-gated runs are human-paced; automatic runs weren't
  isolated in these tests).
- Any of the above on separate hosts for the API, worker and Postgres.
