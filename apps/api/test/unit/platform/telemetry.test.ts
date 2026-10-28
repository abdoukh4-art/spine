import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import fc from 'fast-check';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activeSpanIds,
  contextFromTraceparent,
  traceContextMixin,
  traceEventHandling,
  traceparent,
  traceparentOf,
  withExtractedContext,
} from '../../../src/platform/telemetry/index.js';
import { loggerOptions } from '../../../src/platform/logger.js';
import {
  metricViews,
  SECONDS_BUCKETS,
  spanProcessorsFor,
} from '../../../src/platform/telemetry/sdk.js';

/**
 * A synchronous, stack-based ContextManager: enough for `context.with` in tests without
 * the SDK (the real one, AsyncLocalStorage-based, is installed by NodeSDK at runtime).
 * Async continuations are covered by keeping the stack entry until the promise settles.
 */
class StackContextManager implements ContextManager {
  private stack: Context[] = [];
  active(): Context {
    return this.stack.at(-1) ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    this.stack.push(ctx);
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.stack.pop();
    }
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.stack = [];
    return this;
  }
}

const HEX_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
const hex = (len: number) =>
  fc
    .string({ unit: fc.constantFrom(...HEX_DIGITS), minLength: len, maxLength: len })
    .filter((s) => !/^0+$/.test(s)); // all-zero IDs are invalid per W3C

function contextWithSpan(traceId: string, spanId: string, sampled = true): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
  });
}

beforeAll(() => {
  context.setGlobalContextManager(new StackContextManager());
});
afterAll(() => {
  context.disable();
  trace.disable();
});

describe('traceparent propagation (W3C Trace Context)', () => {
  it('serialises a span context as version-00 traceparent', () => {
    const ctx = contextWithSpan('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7');
    expect(traceparentOf(ctx)).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  });

  it('round-trips any valid trace/span id pair and sampling flag', () => {
    fc.assert(
      fc.property(hex(32), hex(16), fc.boolean(), (traceId, spanId, sampled) => {
        const header = traceparentOf(contextWithSpan(traceId, spanId, sampled));
        expect(header).toBeDefined();
        const extracted = trace.getSpanContext(contextFromTraceparent(header));
        expect(extracted).toMatchObject({
          traceId,
          spanId,
          isRemote: true,
          traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
        });
      }),
    );
  });

  it('returns undefined outside any span', () => {
    expect(traceparentOf(ROOT_CONTEXT)).toBeUndefined();
    expect(traceparent()).toBeUndefined();
  });

  it('ignores absent or malformed traceparents instead of throwing', () => {
    for (const bad of [
      undefined,
      '',
      'garbage',
      '00-zz-yy-01',
      `00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`,
    ]) {
      expect(trace.getSpanContext(contextFromTraceparent(bad))).toBeUndefined();
    }
  });

  it('withExtractedContext runs fn as a child of the remote span', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const seen = withExtractedContext(header, () => activeSpanIds());
    expect(seen).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
    expect(withExtractedContext(undefined, () => activeSpanIds())).toBeUndefined();
  });
});

describe('log correlation mixin', () => {
  it('adds traceId/spanId inside a span and nothing outside', () => {
    expect(traceContextMixin()).toEqual({});
    const ctx = contextWithSpan('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7');
    expect(context.with(ctx, () => traceContextMixin())).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
  });

  it('is wired into every pino logger built from loggerOptions', () => {
    const lines: string[] = [];
    const logger = pino(
      loggerOptions({ LOG_LEVEL: 'info', SERVICE_NAME: 'test', NODE_ENV: 'test' }),
      { write: (l: string) => void lines.push(l) },
    );
    const ctx = contextWithSpan('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7');
    context.with(ctx, () => {
      logger.info('inside');
    });
    logger.info('outside');
    const [inside, outside] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(inside).toMatchObject({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', msg: 'inside' });
    expect(outside).not.toHaveProperty('traceId');
  });
});

describe('traceEventHandling (outbox → BullMQ hop)', () => {
  const exporter = new InMemorySpanExporter();
  beforeAll(() => {
    trace.setGlobalTracerProvider(
      new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
    );
  });
  beforeEach(() => exporter.reset());

  const event = {
    eventId: '01900000-0000-7000-8000-000000000001',
    type: 'alert.ingested',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  };

  it('continues the publisher trace in a CONSUMER span', async () => {
    const result = await traceEventHandling(event, () => Promise.resolve(traceparent()), 'scoring');
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('alert.ingested process');
    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(span?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(span?.attributes).toMatchObject({
      'messaging.message.id': event.eventId,
      'spine.subscriber': 'scoring',
    });
    // The handler's own publishes would carry this span as parent: the chain continues.
    expect(result).toBe(`00-4bf92f3577b34da6a3ce929d0e0e4736-${span?.spanContext().spanId}-01`);
  });

  it('starts a new root trace when the event has no traceparent', async () => {
    await traceEventHandling({ eventId: 'e', type: 'x' }, () => Promise.resolve());
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('x process');
    expect(span?.parentSpanContext).toBeUndefined();
  });

  it('records the error on the span and re-throws it', async () => {
    await expect(
      traceEventHandling(event, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events[0]?.name).toBe('exception');
  });
});

describe('SDK configuration (pure parts)', () => {
  it('exports traces only when an OTLP endpoint is configured', () => {
    const base = { SERVICE_NAME: 's', NODE_ENV: 'test', METRICS_PORT: 0 } as const;
    expect(spanProcessorsFor(base)[0]?.constructor.name).toBe('NoopSpanProcessor');
    expect(
      spanProcessorsFor({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://jaeger:4318/' })[0]
        ?.constructor.name,
    ).toBe('BatchSpanProcessor');
  });

  it('gives every spine_*_seconds histogram second-scale buckets', () => {
    const [view] = metricViews();
    expect(view?.instrumentName).toBe('spine_*_seconds');
    expect(SECONDS_BUCKETS[0]).toBe(0.005);
    expect(SECONDS_BUCKETS).toEqual([...SECONDS_BUCKETS].sort((a, b) => a - b));
  });
});
