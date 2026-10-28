import { metrics as sdkMetrics } from '@opentelemetry/sdk-node';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  registerRuntimeGauges,
  type QueueCountsSource,
} from '../../../src/platform/telemetry/index.js';
import { registerProcessMetrics } from '../../../src/platform/telemetry/process-metrics.js';

/** A pull reader we can collect from on demand (what Prometheus does on each scrape). */
class TestReader extends sdkMetrics.MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

type Point = { name: string; value: number; attributes: Record<string, unknown> };

async function scrape(reader: TestReader): Promise<Point[]> {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap((s) =>
    s.metrics.flatMap((m) =>
      m.dataPoints.map((p) => ({
        name: m.descriptor.name,
        value: p.value as number,
        attributes: p.attributes,
      })),
    ),
  );
}

function setup(): { reader: TestReader; meter: ReturnType<sdkMetrics.MeterProvider['getMeter']> } {
  const reader = new TestReader();
  const provider = new sdkMetrics.MeterProvider({ readers: [reader] });
  return { reader, meter: provider.getMeter('spine') };
}

const logger = pino({ level: 'silent' });

describe('runtime gauges', () => {
  it('reports queue depth per queue and state, and the outbox backlog', async () => {
    const { reader, meter } = setup();
    const queue: QueueCountsSource = {
      name: 'spine-events',
      getJobCounts: () => Promise.resolve({ waiting: 5, active: 2, delayed: 1 }),
    };
    registerRuntimeGauges({
      meter,
      logger,
      queues: [queue],
      outboxBacklog: () => Promise.resolve(42),
    });

    const points = await scrape(reader);
    const depth = points.filter((p) => p.name === 'spine_queue_depth');
    expect(depth).toHaveLength(4);
    expect(depth).toContainEqual({
      name: 'spine_queue_depth',
      value: 5,
      attributes: { queue: 'spine-events', state: 'waiting' },
    });
    // Missing states are reported as 0 rather than omitted, so dashboards do not show gaps.
    expect(depth.find((p) => p.attributes.state === 'failed')?.value).toBe(0);
    expect(points.find((p) => p.name === 'spine_outbox_backlog')?.value).toBe(42);
  });

  it('omits the data points of a failing source instead of failing the scrape', async () => {
    const { reader, meter } = setup();
    const broken: QueueCountsSource = {
      name: 'broken',
      getJobCounts: () => Promise.reject(new Error('redis down')),
    };
    const healthy: QueueCountsSource = {
      name: 'healthy',
      getJobCounts: () => Promise.resolve({ waiting: 1 }),
    };
    registerRuntimeGauges({
      meter,
      logger,
      queues: [broken, healthy],
      outboxBacklog: () => Promise.reject(new Error('pg down')),
    });

    const points = await scrape(reader);
    expect(points.filter((p) => p.attributes.queue === 'broken')).toEqual([]);
    expect(points.filter((p) => p.attributes.queue === 'healthy')).toHaveLength(4);
    expect(points.some((p) => p.name === 'spine_outbox_backlog')).toBe(false);
  });

  it('stops observing after the returned disposer runs', async () => {
    const { reader, meter } = setup();
    const stop = registerRuntimeGauges({
      meter,
      logger,
      queues: [],
      outboxBacklog: () => Promise.resolve(1),
    });
    stop();
    expect((await scrape(reader)).some((p) => p.name === 'spine_outbox_backlog')).toBe(false);
  });

  it('publishes process CPU, memory and event-loop delay', async () => {
    const { reader, meter } = setup();
    registerProcessMetrics(meter);
    const names = new Set((await scrape(reader)).map((p) => p.name));
    expect([...names].sort()).toEqual([
      'spine_nodejs_eventloop_delay_p99_seconds',
      'spine_process_cpu_seconds',
      'spine_process_heap_used_bytes',
      'spine_process_resident_memory_bytes',
    ]);
  });
});
