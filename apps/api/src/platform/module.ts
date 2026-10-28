import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { Db } from './db/database.js';
import type { EventHandler, EventPublisher } from './events/types.js';
import type { Logger } from './logger.js';
import type { Clock, IdGenerator } from './runtime.js';

/**
 * The contract between the platform (shared kernel) and business modules (ADR-0002).
 * A module receives {@link PlatformDeps} plus the public APIs of modules it depends on,
 * and contributes routes, event subscribers, background tasks and readiness checks.
 */
export interface PlatformDeps {
  config: Config;
  logger: Logger;
  db: Db;
  clock: Clock;
  ids: IdGenerator;
  events: EventPublisher;
  /** Shared Redis connection (BullMQ, rate limiting). Null in tests that don't need it. */
  redis: Redis | null;
}

/** A long-running process owned by a module (queue worker, reaper, scheduler…). */
export interface BackgroundTask {
  name: string;
  start(): Promise<void> | void;
  /** Must stop accepting new work and wait for in-flight work (graceful shutdown). */
  stop(): Promise<void>;
}

export interface SpineModule {
  readonly name: string;
  /** Registers HTTP routes. Mounted under `/api/v1`. Every route must set `config.access`. */
  routes?(app: FastifyInstance): Promise<void> | void;
  /** Event subscribers (run in the worker process). */
  subscribers?(): EventHandler[];
  /** Background tasks (run in the worker process). */
  backgroundTasks?(): BackgroundTask[];
  /** Named readiness probes contributed to `/readyz`. */
  readinessChecks?(): Record<string, () => Promise<boolean>>;
}
