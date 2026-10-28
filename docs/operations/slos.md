# SLOs and alerting

Service level objectives say how good is good enough, so that alerts fire on **user
impact** instead of on every wobble. Decision: [ADR-0084](../adr/0084-slos-and-burn-rate-alerting.md).
Rules: `infra/prometheus/alerts.yml` (validated with `promtool check config`).

## Vocabulary in one minute

- **SLI** (indicator): a ratio of good events to valid events, e.g. "non-5xx ingest responses / all ingest requests".
- **SLO** (objective): the target for that ratio over a window, e.g. 99.5 % over 30 days.
- **Error budget:** what the SLO allows to fail: 0.5 % of requests, i.e. about 3.6 hours
  of total outage per 30 days.
- **Burn rate:** how fast the budget is being spent. Burn rate 1 spends exactly the budget
  in 30 days; burn rate 14.4 spends 2 % of it in one hour.

## The objectives

| #   | SLO                         | SLI: good / valid                                                                                                                                                                  | Target (30 d) |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | **Ingest availability**     | responses with status < 500 / all `POST` to `/api/v1/alerts` and `/api/v1/ingest/*` (`http_server_request_duration_count`)                                                         | 99.5 %        |
| 2   | **Ingest → scored latency** | alerts whose score was stored ≤ 2 s after `receivedAt` / alerts scored (`spine_alert_time_to_score_seconds_bucket{le="2"}` / `_count`), i.e. p95 < 2 s                             | 95 %          |
| 3   | **Response-action success** | action steps (`notify`, `create_ticket`, `block_indicator`, `set_status`) with `status="succeeded"` / those `succeeded` or `failed` (`spine_playbook_step_duration_seconds_count`) | 99 %          |

Choices worth explaining:

- **503 back-pressure is "bad" for SLO 1.** We shed load on purpose to protect the
  pipeline, but the sensor's alert was still not accepted; counting it keeps us honest
  about capacity. `429` is not counted: it is a per-client limit, not unavailability.
- **SLO 2 is measured from `receivedAt`, not `occurredAt`.** Spine can't control how late
  a sensor reports (that is MTTD, ADR-0026); it controls what happens after receipt.
- **SLO 2 needs `spine_alert_time_to_score_seconds`** (a histogram the scoring module
  records when it stores a score: `now − alert.receivedAt`). It is proposed to the scoring
  module for Phase 2; until it exists, the rules return no data and never fire.
- **SLO 3 uses steps, not runs.** A run can legitimately end `compensated`; a failed
  action step is the thing an analyst can't trust.
- Liveness/readiness probes are excluded from all SLIs (not traced, not counted).

## Alerting: multi-window, multi-burn-rate

From the Google SRE Workbook (ch. 5). An alert needs a **long window** (it is significant)
**and** a **short window** (it is still happening, so the alert clears quickly once fixed):

| Severity | Burn rate | Long window | Short window | Budget consumed when it fires | Example for SLO 1 (budget 0.5 %) |
| -------- | --------- | ----------- | ------------ | ----------------------------- | -------------------------------- |
| page     | 14.4      | 1 h         | 5 m          | 2 %                           | error ratio > 7.2 %              |
| page     | 6         | 6 h         | 30 m         | 5 %                           | error ratio > 3 %                |
| ticket   | 3         | 1 d         | 2 h          | 10 %                          | error ratio > 1.5 %              |
| ticket   | 1         | 3 d         | 6 h          | 10 %                          | error ratio > 0.5 %              |

Rule names: `SpineIngestErrorBudgetBurnFast` (page), `SpineIngestErrorBudgetBurnSlow`
(ticket), `SpineTimeToScoreBudgetBurn` (page), `SpinePlaybookActionFailures` (page).
Recording rules (`spine:ingest_error_ratio:rate1h` …) precompute the ratios so the alert
expressions stay readable and cheap.

Why not "p95 > 500 ms for 5 minutes"? A short threshold pages on a single slow deploy
that users barely noticed; a long one finds a real outage too late. Burn rates scale the
reaction to how much of the promise is actually at risk.

## Cause-based alerts (tickets)

These don't measure users directly but predict SLO trouble. Each links to a runbook.

| Alert                        | Condition                                  | Runbook                                                                  |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `SpineTargetDown`            | API or worker not scraped for 2 min (page) | [Database down](runbooks.md#database-down)                               |
| `SpineOutboxBacklogGrowing`  | backlog > 1000 and rising for 10 min       | [Outbox backlog growing](runbooks.md#outbox-backlog-growing)             |
| `SpineIngestBackpressure`    | any 503 back-pressure for 5 min            | [Outbox backlog growing](runbooks.md#outbox-backlog-growing)             |
| `SpineQueueFailedJobs`       | failed jobs increasing                     | [Playbook runs stuck](runbooks.md#playbook-runs-stuck-or-failing)        |
| `SpineEnrichmentCircuitOpen` | a provider's circuit open for 5 min        | [Enrichment circuit open](runbooks.md#enrichment-circuit-open)           |
| `SpineApprovalsPiling`       | > 20 approvals pending for 30 min          | [Playbook runs stuck](runbooks.md#playbook-runs-stuck-or-failing)        |
| `SpineEventLoopSaturated`    | event-loop p99 delay > 200 ms for 10 min   | [Ingest errors and 429 storms](runbooks.md#ingest-errors-and-429-storms) |

## Routing alerts

The local stack has no Alertmanager: firing alerts are listed at
`http://localhost:9090/alerts`. In production add to `prometheus.yml`:

```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']
```

and route `severity="page"` to the on-call pager and `severity="ticket"` to the team's
queue. Review the SLOs quarterly: if the budget is never touched, the target may be too
loose (or the SLI measures the wrong thing); if it is always exhausted, either fix
reliability or lower the promise explicitly.
