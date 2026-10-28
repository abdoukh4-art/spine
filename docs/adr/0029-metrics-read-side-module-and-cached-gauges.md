# ADR-0029: Metrics is a read-side module; SOC gauges are refreshed off the scrape path

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture, ops

## Context and problem statement

MTTD, MTTR and playbook success rate need data owned by two other modules (Alerts and
Playbooks). They're needed in two places: on demand in the console
(`GET /metrics/summary` for any window) and continuously in Grafana (as Prometheus gauges).
How should the Metrics module get its data, and how often should it compute gauges?

## Decision drivers

- Module boundaries: no cross-module SQL ([ADR-0002](0002-hexagonal-modular-monolith.md)).
- Exact, testable formulas ([ADR-0026](0026-mttd-mttr-definitions.md)).
- A Prometheus scrape must be cheap and must never trigger heavy queries (scrapes happen every 15 s from possibly several Prometheus servers).

## Considered options

1. **Port `MetricsReadModel` implemented in the composition root over the Alerts/Playbooks public APIs; pure formulas; gauges recomputed every 30 s by a worker background task**
2. Metrics module runs its own SQL against `alerts` and `playbook_runs`
3. Maintain metric projections incrementally from domain events (`alert.status_changed`, `playbook.run.finished`)
4. Compute gauges inside the Prometheus scrape callback

## Decision outcome

**Chosen option 1.**

- `domain/` holds only pure functions (`computeMttd`, `computeMttr`, `computePlaybookStats`,
  `computeAlertVolume`, nearest-rank percentiles), unit-tested on a hand-computed fixture and with property tests.
- `application/GetMetricsSummary` validates the window (default 7 days, max 90 days) and asks
  the `MetricsReadModel` port for rows.
- `adapters/gauges.ts` publishes `spine_mttd_seconds`, `spine_mttr_seconds`,
  `spine_playbook_success_ratio` and `spine_alerts_open_received_24h` over a rolling 24 h
  window, recomputed **every 30 s** in the worker. The scrape callback only reads the cached values.

### Consequences

- 👍 No cross-module SQL, and the formulas are trivially testable.
- 👍 Scrape cost is constant.
- 👎 Summary requests scan up to 90 days of alert timestamps through the alerts API. Fine at
  v0.1 volumes (thousands/day). At larger scale, option 3 (incremental projections) becomes worth its complexity.
- 👎 Gauges can be up to 30 s stale, which is irrelevant for metrics measured in minutes.

## What would make us revisit this

- `GET /metrics/summary` p95 exceeds 500 ms → switch to incremental projections (option 3) or pre-aggregated daily rollups.

## Further reading

- Prometheus docs, _Writing exporters_: "metrics should be cheap to collect"
- Google SRE Workbook, _Implementing SLOs_
