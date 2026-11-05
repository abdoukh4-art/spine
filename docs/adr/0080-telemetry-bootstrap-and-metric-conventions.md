# ADR-0080: Telemetry bootstrap: NodeSDK preload, Prometheus pull, optional OTLP, verified metric naming

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** infra + observability workstream
- **Tags:** ops

## Context and problem statement

[ADR-0019](0019-observability-otel-pino-prometheus.md) chose OpenTelemetry, pino, Prometheus
and Grafana. It left open _how_ the SDK starts, which exporters run when, how a trace
survives the outbox → BullMQ hop, and what the metric names look like once they reach
Prometheus. Those details decide whether the dashboards work at all, so they need a
decision of their own.

Four facts shaped it, each discovered by running the code (see the
[journal](../journal/2026-10-28-infra-observability.md)):

1. Our production build is an **ESM bundle** whose third-party imports (`pg`, `ioredis`,
   `fastify`) are all evaluated before the first line of `main()`. Calling
   `startTelemetry()` inside `main()` is too late to patch them. (We first assumed an ESM
   loader hook was also required; an experiment showed it is not, see below.)
2. The preload and the entrypoint are **separate esbuild bundles**, so a module-level
   "already started?" flag exists twice. The first version started the SDK twice
   (`EADDRINUSE` on 9464 and Fastify crashed on a duplicate decorator).
3. The OTel Prometheus exporter appends `_total` to counters, but **does not append unit
   suffixes**: a histogram created with `unit: 's'` is exported without `_seconds`.
4. The SDK's default histogram buckets (`0, 5, 10, 25 … 10000`) assume **milliseconds**.
   With seconds-valued histograms every sub-5 s observation lands in one bucket and p95
   is meaningless.

## Decision drivers

- Works offline and in tests with zero configuration (no collector required).
- One trace across HTTP → outbox → queue → handler (ADR-0009, ADR-0019).
- Dashboards and alert rules must match the names Prometheus actually stores.
- Small, pinned, mutually compatible dependency set (ADR-0022, ADR-0028).

## Considered options

1. **`NodeSDK` started by a `node --import` preload, Prometheus pull exporter, OTLP/HTTP
   traces only when configured, explicit instrumentation list, a View for seconds buckets**
2. `NodeSDK` started inside `main()` (no preload)
3. Hand-assembled providers (`MeterProvider` + `NodeTracerProvider`) without `NodeSDK`
4. `@opentelemetry/auto-instrumentations-node` (every instrumentation, env-configured)

## Decision outcome

**Chosen option 1.**

- `apps/api/src/instrument.ts` is bundled as `dist/instrument.js` and loaded with
  `node --import ./dist/instrument.js dist/main.js` (Dockerfile, systemd units,
  `pnpm start`) and starts the SDK before the application graph is evaluated. It does
  **not** register the ESM loader hook (`import-in-the-middle`): every library we
  instrument is CommonJS or a Node built-in, which Node loads through the CommonJS loader
  even when imported from ESM, where OpenTelemetry's `require` hook patches it. We tested
  the image with and without the hook: `pg` was instrumented in both cases.
- The running SDK is stored on `globalThis[Symbol.for('spine.telemetry')]`, so the
  entrypoint's `startTelemetry()` returns the same handle instead of starting a second SDK.
- **Metrics:** Prometheus exporter on `METRICS_PORT` (`0` disables it). Pull, not push:
  Prometheus decides the scrape rate, and a dead target shows up as `up == 0`.
- **Traces:** spans are always created in-process (so log lines carry `traceId`/`spanId`
  and the `traceparent` crosses the outbox), and exported over OTLP/HTTP only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise a `NoopSpanProcessor` drops them.
  Sampler: parent-based, always-on at the root.
- **Instrumentations (explicit):** `http` (probes and `/metrics` ignored; calls to the
  OTLP collector ignored), `@fastify/otel` (registered via Fastify's diagnostics channel,
  no hook spans), `pg` and `ioredis` with `requireParentSpan: true` (the outbox poll and
  BullMQ's blocking commands would otherwise create thousands of orphan spans per minute).
- **Async hop:** `traceEventHandling(event, fn)` extracts the stored W3C `traceparent` and
  wraps the handler in a CONSUMER span; it is the event worker's `around` option.
- **Logs:** a pino `mixin` adds `traceId`/`spanId`. No OTel log pipeline: logs stay on stdout.
- **Naming (verified, see [observability.md](../operations/observability.md#metric-naming-as-verified)):**
  counters are created without `_total`; histograms are named `*_seconds` with **no**
  `unit` option; gauges are plain. A View gives every `spine_*_seconds` histogram
  second-scale buckets (5 ms … 1 h).
- **Runtime gauges:** `spine_queue_depth{queue,state}`, `spine_outbox_backlog` (worker),
  process CPU, RSS, heap and event-loop delay (both processes), all ObservableGauges
  evaluated on scrape. No `host-metrics` dependency.
- **Versions:** the `0.222.x` / `2.11.x` OTel line (Aug 2026), not the `0.300` / `3.0`
  majors released 8 days before this ADR (ADR-0022's maturity rule). `@fastify/otel 0.21.2`
  is the newest release built against that line. `pnpm audit`: no known vulnerabilities.

### Consequences

- 👍 `pnpm dev`, unit tests and offline runs need nothing: without the preload, metrics
  and manual spans still work; only library auto-instrumentation needs it.
- 👍 One trace spans the asynchronous pipeline; logs and traces join on `traceId`.
- 👍 Dashboards and alerts were written against names observed on a real `/metrics`.
- 👎 Instruments created **before** `startTelemetry()` stay no-ops forever (the metrics
  API has no proxy meter). Modules must create instruments in factories called from
  `createApplication`, not at import time. Documented in `platform/telemetry/index.ts`.
- 👎 `NodeSDK` pulls in exporters we don't use (gRPC/proto OTLP, Zipkin): about 40 extra
  packages. Accepted for the simpler, documented bootstrap; option 3 is the fallback if
  image size or audit noise becomes a problem.
- 👎 Always-on in-process spans cost some CPU even with no exporter. Measure in Phase 3
  (`performance.md`) and add ratio sampling if it shows up.
- ⚖️ Two processes on one host need two metrics ports (`METRICS_PORT`); the systemd
  units use 9464 (API) and 9465 (worker).

## Pros and cons of the options

### Start inside `main()` (no preload)

- 👍 One fewer moving part.
- 👎 Silently misses `pg`/`ioredis` auto-instrumentation in the bundled build: the
  libraries are already loaded. It looks like it works because metrics still appear.

### Hand-assembled providers

- 👍 Smallest dependency set, every component visible.
- 👎 More bootstrap code to own and teach; `NodeSDK` already handles ordering pitfalls
  (meter provider before instrumentations, propagator, shutdown).

### auto-instrumentations-node

- 👍 Zero code.
- 👎 ~40 instrumentations, env-driven behaviour, large attack and upgrade surface. We
  use four.

## What would make us revisit this

- The OTel JS `3.x` / `0.300` line has been stable for three months → upgrade together
  (one Dependabot group).
- Span volume or CPU from always-on spans matters in the Phase 3 load test → sampling.
- We instrument a library that ships as pure ESM → register the ESM loader hook in the
  preload (prefer Node's synchronous `module.registerHooks()` when available).

## Further reading

- OpenTelemetry JS, _ESM support_ and _Prometheus exporter_ docs
- W3C, _Trace Context_ (Recommendation)
- Prometheus docs, _Metric and label naming_; _Histograms and summaries_
