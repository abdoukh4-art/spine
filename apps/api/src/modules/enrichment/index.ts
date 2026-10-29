import { EnrichmentService, type ResilientProvider } from '@spine/enrichers';
import type { PlatformDeps, SpineModule } from '../../platform/module.js';
import { onAlertIngested } from './adapters/events.js';
import { enrichmentRoutes } from './adapters/http.js';
import { createEnrichmentMetrics, type EnrichmentMetrics } from './adapters/metrics.js';
import { PostgresEnrichmentRepository } from './adapters/postgres.js';
import { createProviders } from './adapters/providers.js';
import { EnrichmentApplication } from './application/enrichment-app.js';
import type { AlertLookup } from './application/ports.js';
import type { EnrichmentPublicApi } from './public-api.js';

export type { AlertLookup } from './application/ports.js';

/** What the enrichment module needs besides the platform. */
export interface EnrichmentModuleOptions {
  /** Reads alert snapshots (for `POST /alerts/:id/enrich`). Wire the alerts public API here. */
  alertLookup: AlertLookup;
  /** Replaces the configured mock providers (tests). */
  providers?: readonly ResilientProvider[];
  /** Replaces the OpenTelemetry instruments (tests). */
  metrics?: EnrichmentMetrics;
}

/**
 * Enrichment module composition (ADR-0002): wires providers (each with its own resilience
 * stack, ADR-0014), the Postgres repository, the `alert.ingested` subscriber, the HTTP
 * routes and the metrics. See docs/modules/enrichment.md.
 */
export function createEnrichmentModule(
  deps: PlatformDeps,
  options: EnrichmentModuleOptions,
): { module: SpineModule; api: EnrichmentPublicApi } {
  const metrics = options.metrics ?? createEnrichmentMetrics();
  const providers =
    options.providers ??
    createProviders(deps.config, {
      onStateChange: (provider, { from, to }) => {
        metrics.recordCircuit(provider, to);
        deps.logger.warn({ provider, from, to }, 'enrichment: circuit breaker state changed');
      },
      onRetry: (provider, { attempt, delayMs }) => {
        deps.logger.debug({ provider, attempt, delayMs }, 'enrichment: retrying lookup');
      },
    });
  for (const p of providers) metrics.recordCircuit(p.name, p.status().circuit);

  const enricher = new EnrichmentService(providers, {
    concurrency: deps.config.ENRICHMENT_CONCURRENCY,
    onResult: (result) => metrics.recordLookup(result),
  });
  const app = new EnrichmentApplication({
    enricher,
    repository: new PostgresEnrichmentRepository(deps.db, deps.events),
    alerts: options.alertLookup,
    clock: deps.clock,
  });

  return {
    api: app,
    module: {
      name: 'enrichment',
      routes: (api) => enrichmentRoutes(api, app),
      subscribers: () => [onAlertIngested(app, deps.logger)],
    },
  };
}
