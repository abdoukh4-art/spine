import type { Logger } from '../../../platform/logger.js';
import type { BackgroundTask } from '../../../platform/module.js';
import type { Clock } from '../../../platform/runtime.js';
import { idempotencyExpiry } from '../domain/idempotency.js';
import type { IdempotencyStore } from './ports.js';

/** Options for {@link idempotencyCleanupTask}. */
export interface IdempotencyCleanupOptions {
  store: IdempotencyStore;
  clock: Clock;
  logger: Logger;
  /** How often to sweep (default: every 15 minutes). */
  intervalMs?: number;
}

/**
 * Background task (worker process) that deletes idempotency records older than 24 h
 * (ADR-0012). Expired records are already ignored on read, so a missed sweep never breaks
 * correctness; the sweep only keeps the table small.
 */
export function idempotencyCleanupTask(options: IdempotencyCleanupOptions): BackgroundTask & {
  /** Runs one sweep now (used by the task and by tests). */
  sweep(): Promise<number>;
} {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<number> | null = null;
  const sweep = async (): Promise<number> => {
    const deleted = await options.store.deleteExpired(idempotencyExpiry(options.clock.now()));
    if (deleted > 0) options.logger.info({ deleted }, 'expired idempotency keys deleted');
    return deleted;
  };
  const tick = (): void => {
    running = sweep()
      .catch((err: unknown) => {
        options.logger.error({ err }, 'idempotency cleanup failed');
        return 0;
      })
      .finally(() => {
        running = null;
      });
  };
  return {
    name: 'ingestion.idempotency-cleanup',
    sweep,
    start() {
      tick();
      timer = setInterval(tick, options.intervalMs ?? 15 * 60 * 1000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      if (running) await running;
    },
  };
}
