import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

/**
 * W3C Trace Context propagation across the asynchronous hop (ADR-0019).
 *
 * The publishing request stores its `traceparent` on the outbox row; the event worker
 * extracts it and continues the same trace, so one trace shows
 * ingest → outbox → queue → handler. We use an explicit W3C propagator rather than the
 * global one: the value we persist must always be a W3C `traceparent`, whatever
 * propagators an operator configures for HTTP.
 */
const propagator = new W3CTraceContextPropagator();

type Carrier = Record<string, string>;

const setter: TextMapSetter<Carrier> = {
  set: (carrier, key, value) => {
    carrier[key] = value;
  },
};

const getter: TextMapGetter<Carrier> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key],
};

/**
 * Serialises the span context of `ctx` (default: the active context) as a W3C
 * `traceparent` header value, e.g. `00-<32 hex trace id>-<16 hex span id>-01`.
 * Returns `undefined` when there is no valid span (tracing off, or outside any span).
 */
export function traceparentOf(ctx: Context = context.active()): string | undefined {
  const carrier: Carrier = {};
  propagator.inject(ctx, carrier, setter);
  return carrier.traceparent;
}

/**
 * Parses a `traceparent` into a context whose (remote) parent span is the one it names.
 * An absent or malformed value yields `base` unchanged, so a bad header never breaks a job.
 */
export function contextFromTraceparent(
  traceparent: string | undefined,
  base: Context = ROOT_CONTEXT,
): Context {
  if (!traceparent) return base;
  return propagator.extract(base, { traceparent }, getter);
}

/**
 * Runs `fn` inside the context described by `traceparent`, so spans started by `fn`
 * become children of the remote span that published the event.
 */
export function withExtractedContext<T>(traceparent: string | undefined, fn: () => T): T {
  if (!traceparent) return fn();
  return context.with(contextFromTraceparent(traceparent, context.active()), fn);
}

/** Minimal shape of a domain event needed to trace its handling. */
export interface TracedEvent {
  eventId: string;
  type: string;
  traceparent?: string;
}

/**
 * Wraps the handling of one event delivery in a CONSUMER span that continues the
 * publisher's trace. Matches the `around` option of `startEventWorker`.
 * Errors are recorded on the span and re-thrown (BullMQ owns retries).
 */
export function traceEventHandling<T>(
  event: TracedEvent,
  fn: () => Promise<T>,
  subscriber?: string,
): Promise<T> {
  return withExtractedContext(event.traceparent, () =>
    trace.getTracer('spine').startActiveSpan(
      `${event.type} process`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.operation.type': 'process',
          'messaging.message.id': event.eventId,
          'spine.event.type': event.type,
          ...(subscriber ? { 'spine.subscriber': subscriber } : {}),
        },
      },
      async (span) => {
        try {
          return await fn();
        } catch (err) {
          span.recordException(err instanceof Error ? err : String(err));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      },
    ),
  );
}

/** Trace/span IDs of the active span, or `undefined` when there is none. */
export function activeSpanIds(): { traceId: string; spanId: string } | undefined {
  const span = trace.getSpan(context.active());
  if (!span) return undefined;
  const sc = span.spanContext();
  return isSpanContextValid(sc) ? { traceId: sc.traceId, spanId: sc.spanId } : undefined;
}

/**
 * pino `mixin`: adds `traceId`/`spanId` to every log line written inside a span, which is
 * what lets you jump from a log line to its trace (and back). Returns `{}` otherwise.
 */
export function traceContextMixin(): { traceId?: string; spanId?: string } {
  return activeSpanIds() ?? {};
}
