# ADR-0084: SLOs with multi-window, multi-burn-rate alerting

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** infra + observability workstream
- **Tags:** ops

## Context and problem statement

ADR-0019 deferred alerting. Threshold alerts ("p95 > 500 ms for 5 min") page on noise
and miss slow leaks. We need a small set of user-facing objectives and alerts that fire
when, and only when, they are at risk.

## Decision drivers

- Alerts tied to user impact (a sensor can't deliver, alerts aren't triaged fast enough),
  not to internal causes.
- Low false-positive rate and fast reset after a fix.
- Expressible in plain Prometheus rules, testable with `promtool`.

## Considered options

1. **Three SLOs with multi-window, multi-burn-rate alerts (SRE Workbook ch. 5) + a few
   cause-based "ticket" alerts**
2. Static thresholds on latency and error rate
3. No alerting until Phase 3

## Decision outcome

**Chosen option 1.** Definitions are in [slos.md](../operations/slos.md) and rules in
`infra/prometheus/alerts.yml`:

| SLO                     | SLI (good events / valid events)                                                    | Objective (30 d) |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------- |
| Ingest availability     | non-5xx responses / all POSTs on `/api/v1/alerts` and `/api/v1/ingest/*`            | 99.5 %           |
| Ingest → scored latency | alerts scored ≤ 2 s after `receivedAt` / alerts scored                              | 95 %             |
| Response-action success | `succeeded` / (`succeeded` + `failed`) action steps (notify, ticket, block, status) | 99 %             |

Paging: burn rate 14.4 over 1 h **and** 5 m, or 6 over 6 h **and** 30 m. Ticket: 3 over
1 d and 2 h, or 1 over 3 d and 6 h. `503` back-pressure counts as **bad** for
availability: from the sensor's side the alert was not accepted, even if we chose to
shed load. The latency SLI needs the histogram `spine_alert_time_to_score_seconds` from
the scoring module (Phase 2); until then those rules evaluate to "no data".

Cause-based alerts (ticket severity): target down, outbox backlog growing, permanently
failed jobs, a circuit open for 5 minutes, sustained back-pressure, approvals piling up,
event-loop saturation. Each links to a runbook section.

### Consequences

- 👍 Pages mean "users are hurt and it is still happening".
- 👍 Each alert links a runbook.
- 👎 Burn-rate rules are harder to read than thresholds; slos.md walks through the math.
- 👎 No Alertmanager in the local stack: alerts are visible at `:9090/alerts` only.

## Pros and cons of the options

### Static thresholds

- 👍 Simple.
- 👎 Either noisy (short windows) or slow (long windows); no notion of budget.

### No alerting yet

- 👎 Phase 3 would then build dashboards without knowing what "bad" means.

## What would make us revisit this

- Real traffic shows the 99.5 % target is too loose or too strict.
- The SLI for latency moves to end-to-end (ingest → playbook decision) once playbooks are automatic.

## Further reading

- Google, _The Site Reliability Workbook_, ch. 2 "Implementing SLOs" and ch. 5 "Alerting on SLOs"
- Alex Hidalgo, _Implementing Service Level Objectives_ (O'Reilly, 2020)
