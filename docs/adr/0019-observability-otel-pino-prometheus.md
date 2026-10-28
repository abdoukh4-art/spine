# ADR-0019: Observability with OpenTelemetry (traces + metrics), pino JSON logs, Prometheus and Grafana

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** ops

## Context and problem statement

Spine is an asynchronous pipeline: HTTP → outbox → queue → handlers → queue → playbook
steps. When something is slow or broken, we need to follow one alert through all of it
and see the system's vital signs (RED: rate, errors, duration; USE: utilization,
saturation, errors).

## Decision drivers

- Vendor-neutral instrumentation.
- Correlation: one ID ties together logs, traces and the alert across async hops.
- Business metrics (MTTD, MTTR, playbook success) next to technical metrics.
- Runs locally in Docker Compose.

## Considered options

1. **OpenTelemetry SDK (traces + metrics) + pino structured logs + Prometheus scrape + Grafana with a provisioned dashboard**
2. `prom-client` only, with no tracing
3. A vendor APM agent (Datadog/New Relic)
4. Elastic stack (APM + Filebeat + Kibana)

## Decision outcome

**Chosen option 1.**

- **Logs:** pino JSON to stdout ([twelve-factor](https://12factor.net/logs)). Every line
  carries `requestId`, `traceId`, `spanId`, and `alertId`/`runId` where relevant. Secrets
  are redacted via pino `redact` paths (`req.headers.authorization`, `*.password`, cookies).
- **Correlation across async hops:** the outbox row stores the W3C `traceparent` of the
  publishing request. The event handler and playbook jobs continue the trace from it, so a
  trace shows ingest → enrich → score → playbook end to end.
- **Metrics:** OTel Meter API with the Prometheus exporter on `:9464/metrics` (API and
  worker each expose one). Instruments include:
  `spine_alerts_ingested_total{source,outcome}`, `spine_ingest_rejected_total{reason}`,
  `spine_enrichment_duration_seconds{provider,status}`, `spine_circuit_state{provider}`,
  `spine_playbook_runs_total{playbook,status}`, `spine_playbook_step_duration_seconds{type,status}`,
  `spine_queue_depth{queue}`, `spine_mttd_seconds` and `spine_mttr_seconds` (gauges over a rolling 24 h window),
  plus standard HTTP server metrics.
- **Traces:** exported via OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
  (e.g. to Jaeger in compose), and disabled otherwise. The default is no-op, so tests
  and offline runs don't fail.
- **Dashboards:** `infra/grafana/dashboards/spine-overview.json` is provisioned
  automatically: alert volume, MTTD, MTTR, playbook success rate, step latency p95, queue
  depth, circuit breaker states.

### Consequences

- 👍 Vendor-neutral. Switching the backend is a config change.
- 👍 Async traces make the event-driven design debuggable, which is the main weakness of event-driven systems.
- 👎 OTel JS SDK packages are numerous and version-coupled, so they are pinned together.
- 👎 Metric cardinality must be watched: labels never include alert IDs or IPs.

## Pros and cons of the options

### prom-client only
- 👍 Simple.
- 👎 No traces, so async debugging is guesswork.

### Vendor APM
- 👎 Not self-hostable or offline, and it costs money.

### Elastic stack
- 👍 Powerful search.
- 👎 Heavy (several GB of RAM) for a laptop demo.

## What would make us revisit this

- Log volume makes stdout collection expensive → sampling or OTel logs pipeline.
- Need for SLO burn-rate alerting → add Alertmanager rules (sketched in [operations/slos.md](../operations/slos.md)).

## Further reading

- *Observability Engineering*, Majors, Fong-Jones, Miranda (O'Reilly, 2022)
- Brendan Gregg, *The USE Method*; Tom Wilkie, *The RED Method*
- Google SRE Book, ch. 6 "Monitoring Distributed Systems" (the four golden signals)
