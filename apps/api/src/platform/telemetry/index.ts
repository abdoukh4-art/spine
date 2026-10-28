import { metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';
import { traceparentOf } from './propagation.js';

/**
 * Telemetry facade (ADR-0019). Modules obtain a Meter/Tracer from here; until the SDK is
 * started these are no-ops, so tests and offline runs need no collector.
 *
 * This file is deliberately light: it only depends on `@opentelemetry/api` and the W3C
 * propagator. The SDK bootstrap (Prometheus exporter, OTLP traces, instrumentations)
 * lives in `./sdk.ts` and is imported only by the process entrypoints, so importing a
 * module in a unit test never loads (or starts) the SDK.
 *
 * Metric instruments: create them in factories/constructors that run after
 * `startTelemetry` (i.e. inside `createApplication`), not at module top level. The OTel
 * API has no "proxy meter": an instrument created from the no-op meter stays a no-op.
 */
export const SPINE_INSTRUMENTATION_SCOPE = 'spine';

/** Returns the Spine meter from the global MeterProvider (no-op until the SDK starts). */
export function getMeter(): Meter {
  return metrics.getMeter(SPINE_INSTRUMENTATION_SCOPE);
}

/** Returns the Spine tracer from the global TracerProvider (no-op until the SDK starts). */
export function getTracer(): Tracer {
  return trace.getTracer(SPINE_INSTRUMENTATION_SCOPE);
}

/** Handle returned by `startTelemetry` (see `./sdk.ts`). */
export interface Telemetry {
  /** Current W3C traceparent header value, if a span is active. */
  traceparent(): string | undefined;
  /** Flushes pending spans and stops the exporters. */
  shutdown(): Promise<void>;
}

/** W3C `traceparent` of the active span, or `undefined` outside a (sampled or not) span. */
export function traceparent(): string | undefined {
  return traceparentOf();
}

export {
  activeSpanIds,
  contextFromTraceparent,
  traceContextMixin,
  traceEventHandling,
  traceparentOf,
  withExtractedContext,
  type TracedEvent,
} from './propagation.js';
export { registerRuntimeGauges, type QueueCountsSource } from './runtime-gauges.js';
