import { outboxBacklog } from '../../platform/events/outbox.js';
import type { PlatformDeps, SpineModule } from '../../platform/module.js';
import type { AlertsPublicApi } from '../alerts/public-api.js';
import { registerIngestionRoutes } from './adapters/http/routes.js';
import { createIngestionMetrics } from './adapters/metrics.js';
import { PostgresIdempotencyStore } from './adapters/postgres/idempotency-store.js';
import { kyselyTransactionRunner } from './adapters/postgres/transaction.js';
import { BackpressureGuard } from './application/backpressure.js';
import { idempotencyCleanupTask } from './application/idempotency-cleanup.js';
import { IngestAlert } from './application/ingest-alert.js';
import { IngestBatch } from './application/ingest-batch.js';
import type { IngestionPublicApi } from './public-api.js';

/** Ports the composition root provides to Ingestion. */
export interface IngestionModuleOptions {
  /** Alerts/Cases public API: where new alerts and duplicates are persisted. */
  alerts: AlertsPublicApi;
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
  const ingest = new IngestAlert({
    alerts: options.alerts,
    events: deps.events,
    tx: kyselyTransactionRunner(deps.db),
    idempotency,
    clock: deps.clock,
    ids: deps.ids,
  });
  const guard = new BackpressureGuard({
    probe: () => outboxBacklog(deps.db),
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
