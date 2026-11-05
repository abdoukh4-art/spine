import type { Meter, ObservableResult } from '@opentelemetry/api';
import type { Logger } from '../logger.js';

/** Job states reported by `spine_queue_depth` (BullMQ names). */
export const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/**
 * Anything that can report job counts per state. BullMQ's `Queue#getJobCounts` matches
 * this shape structurally, so the telemetry kernel needs no BullMQ import (and tests can
 * pass a plain object).
 */
export interface QueueCountsSource {
  readonly name: string;
  getJobCounts(...states: QueueState[]): Promise<Partial<Record<string, number>>>;
}

/**
 * Registers the worker's saturation gauges (USE method):
 *
 * - `spine_queue_depth{queue,state}`: BullMQ jobs per queue and state.
 * - `spine_outbox_backlog`: domain events not yet dispatched by the relay (ADR-0009).
 *
 * They are ObservableGauges: the callbacks run only when Prometheus scrapes, so an idle
 * system costs nothing. A failing source (Redis or Postgres down) is logged at debug
 * level and simply omits its data points for that scrape: a gap in the graph is the
 * honest signal, and the readiness probe reports the outage.
 *
 * @returns a function that unregisters the callbacks (call it before closing the sources).
 */
export function registerRuntimeGauges(options: {
  meter: Meter;
  logger: Logger;
  queues: readonly QueueCountsSource[];
  outboxBacklog?: () => Promise<number>;
}): () => void {
  const { meter, logger } = options;
  const queueDepth = meter.createObservableGauge('spine_queue_depth', {
    description: 'BullMQ jobs per queue and state (waiting, active, delayed, failed)',
  });
  const backlog = meter.createObservableGauge('spine_outbox_backlog', {
    description: 'Domain events written to the outbox but not yet dispatched to the queue',
  });

  const observeQueues = async (result: ObservableResult): Promise<void> => {
    await Promise.all(
      options.queues.map(async (queue) => {
        try {
          const counts = await queue.getJobCounts(...QUEUE_STATES);
          for (const state of QUEUE_STATES) {
            result.observe(counts[state] ?? 0, { queue: queue.name, state });
          }
        } catch (err) {
          logger.debug({ err, queue: queue.name }, 'queue depth observation failed');
        }
      }),
    );
  };
  const observeBacklog = async (result: ObservableResult): Promise<void> => {
    if (!options.outboxBacklog) return;
    try {
      result.observe(await options.outboxBacklog());
    } catch (err) {
      logger.debug({ err }, 'outbox backlog observation failed');
    }
  };

  queueDepth.addCallback(observeQueues);
  backlog.addCallback(observeBacklog);
  return () => {
    queueDepth.removeCallback(observeQueues);
    backlog.removeCallback(observeBacklog);
  };
}
