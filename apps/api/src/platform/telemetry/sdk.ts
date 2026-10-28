import FastifyOtel from '@fastify/otel';
import type { IncomingMessage } from 'node:http';
import { metrics as otelMetrics } from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { envDetector, hostDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { metrics as sdkMetrics, NodeSDK } from '@opentelemetry/sdk-node';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  NoopSpanProcessor,
  ParentBasedSampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Telemetry } from './index.js';
import { traceparentOf } from './propagation.js';
import { registerProcessMetrics } from './process-metrics.js';

/** The subset of configuration telemetry needs (keeps tests and the preload small). */
export type TelemetryConfig = Pick<
  Config,
  'SERVICE_NAME' | 'NODE_ENV' | 'METRICS_PORT' | 'OTEL_EXPORTER_OTLP_ENDPOINT'
>;

/** Paths whose incoming requests are not traced: probes and scrapes would drown real traffic. */
const UNTRACED_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/** Service version reported as `service.version` (set by the image build; see api.Dockerfile). */
function serviceVersion(): string {
  return process.env.SPINE_VERSION ?? process.env.npm_package_version ?? '0.0.0-dev';
}

/** Builds the span processors: OTLP/HTTP export when an endpoint is set, otherwise none. */
export function spanProcessorsFor(config: TelemetryConfig): SpanProcessor[] {
  if (!config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // Spans are still created (so logs carry traceId/spanId and the traceparent crosses
    // the outbox hop) but are dropped instead of exported: correlation works offline.
    return [new NoopSpanProcessor()];
  }
  const base = config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '');
  return [
    new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }) }),
  ];
}

/**
 * Histogram buckets (seconds) for every `spine_*_seconds` histogram. Without this View
 * the SDK's default boundaries (0, 5, 10, 25 … 10000) assume *milliseconds*: every
 * sub-5-second latency would land in one bucket and p95 would be meaningless.
 * Spans 5 ms (a cache hit) to 1 h (a playbook waiting on a human approval).
 */
export const SECONDS_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300, 900, 3600,
];

/** Views applied to the MeterProvider (see {@link SECONDS_BUCKETS}). */
export function metricViews(): sdkMetrics.ViewOptions[] {
  return [
    {
      instrumentName: 'spine_*_seconds',
      instrumentType: sdkMetrics.InstrumentType.HISTOGRAM,
      aggregation: {
        type: sdkMetrics.AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: { boundaries: SECONDS_BUCKETS },
      },
    },
  ];
}

/** The auto-instrumentations Spine enables. Kept explicit: every one has a cost. */
export function instrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req: IncomingMessage) =>
        UNTRACED_PATHS.has((req.url ?? '').split('?')[0] ?? ''),
    }),
    // Route-level spans via Fastify's diagnostics channel: no change to server.ts needed.
    new FastifyOtel.FastifyOtelInstrumentation({ registerOnInitialization: true }),
    // Only trace queries/commands that belong to a traced operation: the outbox relay
    // polls every 200 ms and BullMQ issues blocking Redis commands continuously, which
    // would otherwise produce thousands of orphan root spans per minute.
    new PgInstrumentation({ requireParentSpan: true }),
    new IORedisInstrumentation({ requireParentSpan: true }),
  ];
}

/**
 * Process-wide registry for the running SDK. It lives on `globalThis` (under a
 * `Symbol.for` key) rather than in a module variable because the preload
 * (`dist/instrument.js`) and the entrypoint (`dist/main.js`) are *separate esbuild
 * bundles*: each has its own copy of this module, so a module-level `let` would let the
 * SDK start twice (two Prometheus servers on one port, every instrumentation doubled).
 */
const REGISTRY = Symbol.for('spine.telemetry');
type TelemetryRegistry = { [REGISTRY]?: Telemetry };
const registry = globalThis as TelemetryRegistry;

/**
 * Starts the OpenTelemetry Node SDK once per process (ADR-0019, ADR-0080):
 *
 * - **Metrics:** Prometheus pull exporter on `METRICS_PORT` at `/metrics`
 *   (`METRICS_PORT=0` disables the endpoint, e.g. when API and worker share a host in dev).
 * - **Traces:** always created in-process; exported over OTLP/HTTP only when
 *   `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 * - **Logs:** stay on stdout via pino (no OTel log pipeline).
 * - **Resource:** `service.name`, `service.version`, `deployment.environment.name`.
 *
 * Idempotent: the preload (`src/instrument.ts`, loaded with `node --import`) starts it
 * before any instrumented library is imported; the entrypoint's later call returns the
 * same handle. Nothing happens at import time; tests never call this.
 */
export function startTelemetry(config: TelemetryConfig, logger: Logger): Telemetry {
  const existing = registry[REGISTRY];
  if (existing) return existing;

  const metricReaders =
    config.METRICS_PORT > 0
      ? [
          new PrometheusExporter({ port: config.METRICS_PORT, endpoint: '/metrics' }, (err) => {
            if (err) logger.error({ err, port: config.METRICS_PORT }, 'metrics endpoint failed');
          }),
        ]
      : [];

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': config.SERVICE_NAME,
      'service.version': serviceVersion(),
      'deployment.environment.name': config.NODE_ENV,
    }),
    // envDetector honours OTEL_RESOURCE_ATTRIBUTES; hostDetector adds host.name.
    resourceDetectors: [envDetector, hostDetector],
    textMapPropagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    metricReaders,
    views: metricViews(),
    spanProcessors: spanProcessorsFor(config),
    // Explicitly no OTel log export: logs are pino JSON on stdout (twelve-factor XI).
    logRecordProcessors: [],
    instrumentations: instrumentations(),
  });
  sdk.start();
  registerProcessMetrics(otelMetrics.getMeter('spine'));

  logger.info(
    {
      metricsPort: config.METRICS_PORT > 0 ? config.METRICS_PORT : 'disabled',
      traceExport: config.OTEL_EXPORTER_OTLP_ENDPOINT ? 'otlp-http' : 'none',
    },
    'telemetry started',
  );

  let stopped: Promise<void> | undefined;
  const telemetry: Telemetry = {
    traceparent: () => traceparentOf(),
    shutdown: () => (stopped ??= sdk.shutdown()),
  };
  registry[REGISTRY] = telemetry;
  return telemetry;
}
