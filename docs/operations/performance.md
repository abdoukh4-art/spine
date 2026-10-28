# Performance

> **Status:** method and tooling ready (Phase 1); measured results are recorded in
> Phase 3, once the ingestion, enrichment, scoring and playbook modules are integrated.

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
