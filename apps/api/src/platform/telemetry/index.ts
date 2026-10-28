import { metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * Telemetry facade (ADR-0019). Modules obtain a Meter/Tracer from here; until the SDK is
 * started these are no-ops, so tests and offline runs need no collector.
 * The SDK bootstrap (Prometheus exporter, OTLP traces) is implemented by the
 * observability workstream in `startTelemetry`.
 */
export const SPINE_INSTRUMENTATION_SCOPE = 'spine';

export function getMeter(): Meter {
  return metrics.getMeter(SPINE_INSTRUMENTATION_SCOPE);
}

export function getTracer(): Tracer {
  return trace.getTracer(SPINE_INSTRUMENTATION_SCOPE);
}

export interface Telemetry {
  /** Current W3C traceparent header value, if a span is active. */
  traceparent(): string | undefined;
  shutdown(): Promise<void>;
}

/** Starts telemetry exporters. Phase 0: no-op implementation. */
export function startTelemetry(_config: Config, _logger: Logger): Telemetry {
  return {
    traceparent: () => undefined,
    shutdown: () => Promise.resolve(),
  };
}
