# Runbooks

What to do when an alert fires. Each section: **symptoms** (what you see), **impact**,
**diagnose** (commands, in order), **mitigate** (stop the bleeding), **fix** (root
cause), **verify**. Commands assume the Compose stack (`dc` = `docker compose -f
infra/docker-compose.yml --env-file .env`); on systemd use `journalctl -u spine-api` /
`spine-worker` and `psql` directly.

General first steps for any incident:

1. Open the Grafana **Spine overview** dashboard: which row is red?
2. `curl -s localhost:8080/readyz`: which dependency check fails?
3. `dc ps`: is any container restarting or unhealthy?
4. Pick a failing request's `X-Request-ID` and `grep` the logs for it; follow its
   `traceId` into Jaeger if tracing is enabled.

---

## Outbox backlog growing

**Alerts:** `SpineOutboxBacklogGrowing`, `SpineIngestBackpressure`, `SpineTimeToScoreBudgetBurn`.

**Symptoms:** `spine_outbox_backlog` or `spine_queue_depth{queue="spine-events",state="waiting"}`
rises steadily; ingestion starts answering `503` once their sum passes `INGEST_MAX_BACKLOG`
([ADR-0093](../adr/0093-backpressure-counts-the-whole-pipeline.md)); alerts appear in the console but are not enriched
or scored.

**Impact:** detection latency grows (MTTD unaffected, time-to-score and MTTR worsen).
No data is lost: events wait in Postgres (outbox) or in Redis (queue).

**Diagnose**

```bash
dc ps worker                               # is the worker running and healthy?
dc logs --since 10m worker | grep -E '"level":"(error|warn)"' | tail -20
# Oldest undispatched event and how long it has waited:
dc exec -T postgres psql -U spine -c "SELECT type, occurred_at, attempts, now() - occurred_at AS waiting FROM domain_events WHERE dispatched_at IS NULL ORDER BY id LIMIT 5;"
```

Then look at `spine_queue_depth{queue="spine-events"}`:

- **Backlog high, queue empty** → the **relay** is stuck (worker down, `outbox relay
batch failed` errors, Redis unreachable so enqueue fails).
- **Backlog low, queue `waiting` high** → **handlers** are slow (enrichment provider
  slow/open circuit, DB saturation). See the enrichment and playbook sections.

**Mitigate**

- Worker down: `dc up -d worker` (or `systemctl restart spine-worker`).
- Handlers slow: raise `EVENT_WORKER_CONCURRENCY` or run a second worker
  (`dc up -d --scale worker=2`: the relay uses `SKIP LOCKED`, so relays don't collide).
- Back-pressure is doing its job: sensors retry on `503`; don't raise
  `INGEST_MAX_BACKLOG` to hide the symptom.

**Fix:** the error in the worker logs (poison event, DB permissions, Redis memory full:
see [Redis out of memory](#redis-wiped)).

**Verify:** backlog trends to ~0 and `spine_alerts_scored_total` rate returns to the
ingest rate.

---

## Enrichment circuit open

**Alert:** `SpineEnrichmentCircuitOpen` (circuit `open` for 5 minutes).

**Symptoms:** circuit timeline shows a provider in red; enrichment p95 for that provider
drops (calls fail fast) and alerts are enriched with `status: unavailable` for it.

**Impact:** scores are computed with less context (ADR-0015 rules that need that
provider don't fire). Alerts still flow; this is the breaker protecting the pipeline
(ADR-0014).

**Diagnose:** `GET /api/v1/enrichment/providers` (state, last error);
`dc logs worker | grep '"provider":"<name>"'`; is the provider down, slow (timeouts) or
rejecting us (401/429 = credentials or quota)?

**Mitigate:** nothing is required; the breaker half-opens and probes on its own. If the
provider is down for hours, consider disabling it in config so scores are explicit about
the missing source.

**Fix:** credentials/quota with the provider; for timeouts, check egress/DNS from the worker.

**Verify:** state returns to `closed`; re-enrich affected alerts with
`POST /api/v1/alerts/:id/enrich` if their scores matter.

---

## Playbook runs stuck or failing

**Alerts:** `SpinePlaybookActionFailures`, `SpineQueueFailedJobs`, `SpineApprovalsPiling`.

**Symptoms:** runs stay `running`/`waiting_approval`; `spine_queue_depth{queue="spine-playbook-runs",state="failed"}` grows; success-rate panel drops.

**Diagnose**

```bash
# Runs that have not moved for 15 minutes:
curl -s -H "authorization: Bearer $TOKEN" 'localhost:8080/api/v1/runs?status=running' | jq '.items[] | {id, playbookId, startedAt}'
# The run's timeline (append-only events, ADR-0010) shows the last step and its error:
curl -s -H "authorization: Bearer $TOKEN" localhost:8080/api/v1/runs/<runId> | jq '.events[-5:]'
```

- Last event `approval.requested` → it is **waiting for a human**: see the approvals
  queue in the console. Not a fault; `SpineApprovalsPiling` means staffing, not software.
- Last event `step.retry_scheduled` repeating → an action adapter keeps failing
  (simulated adapters fail only with `SIMULATION_FAILURE_RATE` > 0).
- No recent event and no job in BullMQ → the job was lost (e.g. Redis wiped): see below.

**Mitigate:** cancel runs that should not continue (`POST /api/v1/runs/:id/cancel`);
compensation runs for steps that need undoing.

**Fix:** adapter configuration; for lost jobs, restart the worker (the reconciler
re-enqueues every non-terminal run at start, ADR-0008).

**Verify:** run reaches a terminal status; failed-jobs gauge stops growing.

---

## Database down

**Alerts:** `SpineTargetDown` (processes crash-looping), readiness failing.

**Symptoms:** `/readyz` → `503 {"checks":{"database":"fail"}}`; API `5xx`; worker logs
`outbox relay batch failed`; containers restarting.

**Impact:** total outage of ingestion and the console. Sensors retry (they get `503`).

**Diagnose**

```bash
dc ps postgres && dc logs --tail 50 postgres
dc exec postgres pg_isready -U spine
df -h   # a full disk is the most common cause: see "Disk full"
```

**Mitigate:** restart Postgres (`dc restart postgres`). API and worker reconnect on
their own (pg pool) and become ready again; no restart needed.

**Fix:** depends on the cause (disk, memory limit, corruption → restore from backup, see
[backup-restore.md](backup-restore.md)).

**Verify:** `/readyz` is `ready`; outbox backlog drains; no `5xx` in the RED panel.

---

## Redis wiped

Also covers: Redis restarted without its RDB file, `FLUSHALL`, or Redis out of memory.

**Symptoms:** BullMQ queues are suddenly empty; runs stuck in `running` with no job;
events marked dispatched in Postgres were never handled (alerts not enriched/scored).
Out of memory: worker errors `OOM command not allowed when used memory > 'maxmemory'`
(with `noeviction`, Redis refuses writes rather than silently dropping jobs).

**Impact:** in-flight work is lost from the queue. Postgres still has everything
(ADR-0008: Redis is not the source of truth).

**Recover**

1. **Playbook runs:** restart the worker. The reconciler re-enqueues every non-terminal
   run with a deterministic job ID (duplicates are ignored).

   ```bash
   dc restart worker
   ```

2. **Domain events dispatched shortly before the loss:** re-dispatch them. Handlers are
   idempotent and job IDs are `eventId__subscriber`, so re-delivering an event that was
   already handled is harmless. Choose a window that covers the loss (here 30 minutes):

   ```bash
   dc exec -T postgres psql -U spine -c \
     "UPDATE domain_events SET dispatched_at = NULL WHERE dispatched_at > now() - interval '30 minutes';"
   ```

   The relay picks them up within `OUTBOX_POLL_INTERVAL_MS`.

3. **Out of memory instead:** find what grew (`dc exec redis redis-cli info memory`,
   `redis-cli --bigkeys`). Usually failed jobs kept for inspection (`removeOnFail` keeps
   7 days) or a stuck consumer. Clean failed jobs after reading them, or raise
   `--maxmemory`; never switch to an evicting policy.

**Verify:** queue depth gauges show activity; the runs from step 1 progress; recently
ingested alerts get scores.

---

## Ingest errors and 429 storms

**Alerts:** `SpineIngestErrorBudgetBurnFast` / `…Slow`, `SpineEventLoopSaturated`.

**Symptoms:** RED panel shows `5xx` or a high `429` ratio on `/api/v1/alerts` or
`/api/v1/ingest/*`.

**Diagnose:** split by status code:

- **`503`** = back-pressure → [Outbox backlog growing](#outbox-backlog-growing).
- **`500`** → the API logs for those request IDs (`"level":"error"`); often the DB.
- **`429` from nginx** (response has no API headers, nginx JSON log shows `"status":429`)
  → one IP exceeds the edge limits (`limit_req`): a misconfigured sensor retrying in a
  tight loop, or an attack. **`429` from the API** (`retry-after` header, problem JSON)
  → per-client API limit (`RATE_LIMIT_MAX_PER_MINUTE`).
- High event-loop delay with high CPU → the API is CPU-bound (large batch imports,
  expensive normalizers): scale out or cap batch size.

**Mitigate:** identify the client (`remoteAddr` in nginx's JSON log, the `source` label in
`spine_alerts_ingested_total`) and fix its retry policy (exponential backoff honouring
`Retry-After`). For an abusive IP, block it at the firewall or in nginx (`deny`). Raise
limits only for a known, legitimate high-volume source.

**Verify:** error ratio back under 0.5 %; burn-rate alert resolves within its short window.

---

## Disk full

**Symptoms:** Postgres `PANIC: could not write to file` / `No space left on device`, then
[Database down](#database-down); Prometheus stops ingesting; Docker can't start containers.

**Diagnose**

```bash
df -h; docker system df
dc exec -T postgres psql -U spine -c "SELECT pg_size_pretty(pg_database_size('spine'));"
dc exec -T postgres psql -U spine -c "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 5;"
```

**Mitigate (in this order, safest first):**

1. Remove what Docker can rebuild: `docker image prune -f`, `docker builder prune -f`.
2. Lower Prometheus retention (`--storage.tsdb.retention.time`, 15 d by default) and restart it.
3. Container logs are already rotated (10 MB × 3 per service); check host logs (`journalctl --vacuum-size=500M`).
4. **Never delete files under the Postgres data directory.** Free space elsewhere or grow the volume.

**Fix:** capacity planning: the largest tables are usually `domain_events` (one row per
event, kept for audit) and `alerts.raw`. Add a retention job for dispatched events older
than N days (not built yet; on the roadmap in [STATUS](../STATUS.md)) and monitor the volume (node-exporter, or `df` in your host monitoring).

**Verify:** Postgres accepts writes (`/readyz` ready), Prometheus targets `up`.
