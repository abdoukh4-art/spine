import { parseEventPayload, type DomainEvent } from '@spine/shared-schema';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { DeliveryQueue, EventDelivery } from '../events/outbox.js';
import type { EventSubscriptions } from '../events/types.js';
import type { Logger } from '../logger.js';

/** Queue names (ADR-0008). Hyphenated: BullMQ uses ':' internally as a key separator. */
export const QUEUE_NAMES = {
  events: 'spine-events',
  playbookRuns: 'spine-playbook-runs',
} as const;

/**
 * Creates an ioredis connection suitable for BullMQ workers
 * (`maxRetriesPerRequest: null` is required by BullMQ for blocking commands).
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

/** Readiness probe for Redis. */
export async function pingRedis(redis: Redis): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

/** Job IDs must not contain ':' in BullMQ; `__` is our separator. */
export function deliveryJobId(delivery: EventDelivery): string {
  return `${delivery.event.eventId}__${delivery.subscriber}`;
}

/** Default retry policy for event deliveries: exponential backoff, kept for inspection. */
const DELIVERY_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 500 },
  // Keep completed job IDs for a day so re-dispatches of the same delivery are deduplicated.
  removeOnComplete: { age: 24 * 3600, count: 100_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** {@link DeliveryQueue} backed by BullMQ: one job per (event, subscriber). */
export class BullMqDeliveryQueue implements DeliveryQueue {
  readonly queue: Queue<EventDelivery>;

  constructor(connection: ConnectionOptions) {
    this.queue = new Queue<EventDelivery>(QUEUE_NAMES.events, { connection });
  }

  async enqueue(deliveries: readonly EventDelivery[]): Promise<void> {
    if (deliveries.length === 0) return;
    await this.queue.addBulk(
      deliveries.map((d) => ({
        name: `${d.event.type}:${d.subscriber}`,
        data: d,
        opts: { ...DELIVERY_JOB_OPTIONS, jobId: deliveryJobId(d) },
      })),
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Consumes event deliveries and invokes the named subscriber. Payloads are re-validated
 * against the catalog, so a malformed event fails loudly instead of corrupting a handler.
 */
export function startEventWorker(options: {
  connection: ConnectionOptions;
  subscriptions: EventSubscriptions;
  logger: Logger;
  concurrency: number;
  /** Optional wrapper (e.g. to continue the trace from `event.traceparent`). */
  around?: <T>(event: DomainEvent, fn: () => Promise<T>) => Promise<T>;
}): Worker<EventDelivery> {
  const { subscriptions, logger } = options;
  const around = options.around ?? (<T>(_e: DomainEvent, fn: () => Promise<T>) => fn());
  const worker = new Worker<EventDelivery>(
    QUEUE_NAMES.events,
    async (job: Job<EventDelivery>) => {
      const { subscriber, event } = job.data;
      const handler = subscriptions.byHandlerName(subscriber);
      if (!handler) {
        logger.warn({ subscriber, eventType: event.type }, 'no handler for delivery; dropping');
        return;
      }
      const validated = {
        ...event,
        payload: parseEventPayload(event.type, event.payload),
      } as DomainEvent;
      await around(validated, () => handler.handle(validated));
    },
    { connection: options.connection, concurrency: options.concurrency },
  );
  worker.on('failed', (job, err) => {
    logger.error(
      {
        err,
        subscriber: job?.data.subscriber,
        eventId: job?.data.event.eventId,
        attempts: job?.attemptsMade,
      },
      'event delivery failed',
    );
  });
  return worker;
}
