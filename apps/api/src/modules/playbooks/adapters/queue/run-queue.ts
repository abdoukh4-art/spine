import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Logger } from '../../../../platform/logger.js';
import type { BackgroundTask } from '../../../../platform/module.js';
import { QUEUE_NAMES } from '../../../../platform/queue/bullmq.js';
import type { RunQueue } from '../../application/ports.js';

/** Payload of a run job. The queue never carries state, only which run to advance (ADR-0008). */
export interface RunJobData {
  runId: string;
}

/**
 * Deterministic job IDs make enqueueing idempotent: the same `(runId, seq)` is accepted
 * once while a job with that ID is waiting, delayed or active. BullMQ forbids ':' in custom
 * IDs, hence `__`.
 *
 * Delayed retry jobs also carry `notBefore` and the time they were scheduled. Without the
 * second part, a job that wakes up a little early (clock skew between processes) would
 * try to schedule "the same" delayed job while it is itself still active under that ID,
 * BullMQ would drop the add as a duplicate, and the run would stall until the next restart.
 */
export function runJobId(
  runId: string,
  seq: number,
  delayed?: { notBefore: string; scheduledAt: number },
): string {
  const base = `run__${runId}__${seq}`;
  return delayed === undefined
    ? base
    : `${base}__${Date.parse(delayed.notBefore)}__${delayed.scheduledAt}`;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  // Completed IDs are dropped at once so a later legitimate enqueue with the same ID works;
  // failed jobs are kept a week for inspection.
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** {@link RunQueue} on BullMQ's `spine-playbook-runs` queue. The Queue is created lazily. */
export class BullMqRunQueue implements RunQueue {
  private queue: Queue<RunJobData> | undefined;

  /** @param prefix BullMQ key prefix; tests use a unique one per file for isolation. */
  constructor(
    private readonly connection: ConnectionOptions,
    private readonly prefix?: string,
  ) {}

  /** The underlying queue (tests inspect it). */
  get bullQueue(): Queue<RunJobData> {
    this.queue ??= new Queue<RunJobData>(QUEUE_NAMES.playbookRuns, {
      connection: this.connection,
      ...(this.prefix ? { prefix: this.prefix } : {}),
    });
    return this.queue;
  }

  async enqueue(
    runId: string,
    seq: number,
    options?: { delayMs: number; notBefore: string },
  ): Promise<void> {
    await this.bullQueue.add(
      'advance',
      { runId },
      {
        ...JOB_OPTIONS,
        jobId: runJobId(
          runId,
          seq,
          options ? { notBefore: options.notBefore, scheduledAt: Date.now() } : undefined,
        ),
        ...(options ? { delay: Math.max(0, options.delayMs) } : {}),
      },
    );
  }

  async close(): Promise<void> {
    await this.queue?.close();
  }
}

/** Used when no Redis is configured (tests, OpenAPI generation): enqueueing is a no-op. */
export class NoopRunQueue implements RunQueue {
  enqueue(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The executor worker: consumes run jobs with bounded concurrency
 * (`PLAYBOOK_WORKER_CONCURRENCY`, a bulkhead between runs and the event pipeline).
 * On shutdown it aborts in-flight handlers, so steps stop promptly and resume later.
 */
export class RunWorkerTask implements BackgroundTask {
  readonly name = 'playbook-run-worker';
  private worker: Worker<RunJobData> | undefined;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly options: {
      connection: ConnectionOptions;
      concurrency: number;
      logger: Logger;
      advance: (runId: string, signal: AbortSignal) => Promise<unknown>;
      prefix?: string;
    },
  ) {}

  start(): void {
    const { logger } = this.options;
    this.worker = new Worker<RunJobData>(
      QUEUE_NAMES.playbookRuns,
      async (job: Job<RunJobData>) => {
        await this.options.advance(job.data.runId, this.shutdown.signal);
      },
      {
        connection: this.options.connection,
        concurrency: this.options.concurrency,
        ...(this.options.prefix ? { prefix: this.options.prefix } : {}),
      },
    );
    this.worker.on('failed', (job, err) => {
      logger.error({ err, runId: job?.data.runId, attempts: job?.attemptsMade }, 'run job failed');
    });
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    await this.worker?.close();
  }
}
