import path from 'node:path';
import { pipelineBacklogProbe } from '../../platform/events/backlog.js';
import { outboxBacklog } from '../../platform/events/outbox.js';
import { eventQueueCounter } from '../../platform/queue/bullmq.js';
import { InFlightLimit } from '../../platform/http/in-flight-limit.js';
import type { PlatformDeps, SpineModule } from '../../platform/module.js';
import type { AlertsPublicApi } from '../alerts/public-api.js';
import { registerIngestionRoutes } from './adapters/http/routes.js';
import { loadSigmaCatalog } from './adapters/sigma-loader.js';
import { createIngestionMetrics } from './adapters/metrics.js';
import { PostgresIdempotencyStore } from './adapters/postgres/idempotency-store.js';
import { kyselyTransactionRunner } from './adapters/postgres/transaction.js';
import { BackpressureGuard } from './application/backpressure.js';
import { idempotencyCleanupTask } from './application/idempotency-cleanup.js';
import { IngestAlert } from './application/ingest-alert.js';
import { IngestBatch } from './application/ingest-batch.js';
import type { SigmaCatalog } from './domain/sigma.js';
import type { IngestionPublicApi } from './public-api.js';

/** Ports the composition root provides to Ingestion. */
export interface IngestionModuleOptions {
  /** Alerts/Cases public API: where new alerts and duplicates are persisted. */
  alerts: AlertsPublicApi;
  /** Use this Sigma catalog instead of loading `CONFIG_DIR/sigma` (tests). */
  sigma?: SigmaCatalog;
}

/**
 * Ingestion module composition (docs/modules/ingestion.md): normalizers → IngestAlert use case
 * → alerts public API, behind back-pressure, idempotency and webhook HMAC checks.
 */
export function createIngestionModule(
  deps: PlatformDeps,
  options: IngestionModuleOptions,
): { module: SpineModule; api: IngestionPublicApi } {
  const idempotency = new PostgresIdempotencyStore(deps.db);
  const sigma = options.sigma ?? loadSigma(deps);
  const ingest = new IngestAlert({
    alerts: options.alerts,
    events: deps.events,
    tx: kyselyTransactionRunner(deps.db),
    idempotency,
    clock: deps.clock,
    ids: deps.ids,
    sigma,
  });
  const guard = new BackpressureGuard({
    probe: pipelineBacklogProbe({
      outbox: () => outboxBacklog(deps.db),
      queue: deps.redis ? eventQueueCounter(deps.redis) : null,
    }),
    clock: deps.clock,
    maxBacklog: deps.config.INGEST_MAX_BACKLOG,
  });
  const cleanup = idempotencyCleanupTask({
    store: idempotency,
    clock: deps.clock,
    logger: deps.logger,
  });
  const metrics = createIngestionMetrics();
  return {
    api: {},
    module: {
      name: 'ingestion',
      routes: (api) =>
        registerIngestionRoutes(api, {
          ingest,
          batch: new IngestBatch(ingest),
          guard,
          inFlight: new InFlightLimit(deps.config.INGEST_MAX_IN_FLIGHT),
          metrics,
          clock: deps.clock,
          webhookSources: deps.config.WEBHOOK_SOURCES_JSON,
          rateLimitPerMinute: deps.config.INGEST_RATE_LIMIT_PER_MINUTE,
        }),
      backgroundTasks: () => [cleanup],
      readinessChecks: () => ({ 'ingest-backlog': () => guard.healthy() }),
    },
  };
}

/** Loads `CONFIG_DIR/sigma` at startup; an invalid catalog stops the process (ADR-0098). */
function loadSigma(deps: PlatformDeps): SigmaCatalog {
  const { catalog, skipped } = loadSigmaCatalog(path.resolve(deps.config.CONFIG_DIR, 'sigma'));
  deps.logger.info({ rules: catalog.size, skipped }, 'sigma rule catalog loaded');
  return catalog;
}
