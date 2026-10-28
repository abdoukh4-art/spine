import { Queue, type Worker } from 'bullmq';
import { createApplication } from './composition.js';
import { loadConfig } from './platform/config.js';
import { OutboxRelay, outboxBacklog } from './platform/events/outbox.js';
import { installGracefulShutdown, type Closer } from './platform/lifecycle.js';
import { createLogger } from './platform/logger.js';
import {
  BullMqDeliveryQueue,
  QUEUE_NAMES,
  createRedis,
  startEventWorker,
} from './platform/queue/bullmq.js';
import { getMeter, registerRuntimeGauges, traceEventHandling } from './platform/telemetry/index.js';
import { startTelemetry } from './platform/telemetry/sdk.js';

/**
 * Worker process entrypoint: outbox relay, event subscribers and module background tasks
 * (e.g. the playbook executor). Scales independently of the API (ADR-0008).
 */
async function main(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    SERVICE_NAME: process.env.SERVICE_NAME ?? 'spine-worker',
  });
  const logger = createLogger(config);
  const telemetry = startTelemetry(config, logger);
  const redis = createRedis(config.REDIS_URL);
  const app = createApplication(config, {
    logger,
    redis,
    traceparent: () => telemetry.traceparent(),
  });

  const deliveryQueue = new BullMqDeliveryQueue(redis);
  const relay = new OutboxRelay(app.deps.db, app.subscriptions, deliveryQueue, logger, {
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
  });
  const eventWorker: Worker = startEventWorker({
    connection: redis,
    subscriptions: app.subscriptions,
    logger,
    concurrency: config.EVENT_WORKER_CONCURRENCY,
    // Continue the publisher's trace across the outbox → BullMQ hop (ADR-0019).
    around: (event, fn) => traceEventHandling(event, fn),
  });
  // Saturation gauges, observed on each Prometheus scrape (spine_queue_depth, spine_outbox_backlog).
  const observedQueues = Object.values(QUEUE_NAMES).map(
    (name) => new Queue(name, { connection: redis }),
  );
  const stopGauges = registerRuntimeGauges({
    meter: getMeter(),
    logger,
    queues: observedQueues,
    outboxBacklog: () => outboxBacklog(app.deps.db),
  });
  const tasks = app.modules.flatMap((m) => m.backgroundTasks?.() ?? []);

  relay.start();
  for (const task of tasks) await task.start();
  logger.info(
    { subscribers: app.subscriptions.all().map((h) => h.name), tasks: tasks.map((t) => t.name) },
    'worker started',
  );

  const closers: Closer[] = [
    { name: 'outbox-relay', close: () => relay.stop() },
    { name: 'event-worker', close: () => eventWorker.close() },
    ...tasks.map((t) => ({ name: t.name, close: () => t.stop() })),
    { name: 'delivery-queue', close: () => deliveryQueue.close() },
    {
      name: 'runtime-gauges',
      close: async () => {
        stopGauges();
        await Promise.all(observedQueues.map((q) => q.close()));
      },
    },
    { name: 'database', close: () => app.deps.db.destroy() },
    { name: 'redis', close: async () => void (await redis.quit()) },
    { name: 'telemetry', close: () => telemetry.shutdown() },
  ];
  installGracefulShutdown({ logger, timeoutMs: config.SHUTDOWN_TIMEOUT_MS, closers });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- logger may not exist yet if config failed
  console.error(err);
  process.exit(1);
});
