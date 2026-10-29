import type { PlatformDeps, SpineModule } from '../../platform/module.js';
import { GetMetricsSummary, type MetricsReadModel } from './application/get-metrics-summary.js';
import { createSocGaugesTask } from './adapters/gauges.js';
import { registerMetricsRoutes } from './adapters/http.js';

export type { MetricsReadModel } from './application/get-metrics-summary.js';

/**
 * Metrics module composition (docs/modules/metrics.md). A read-side module: it owns no
 * tables and reads other modules through the {@link MetricsReadModel} port, which the
 * composition root implements on top of their public APIs.
 */
export function createMetricsModule(
  deps: PlatformDeps,
  readModel: MetricsReadModel,
): { module: SpineModule } {
  const getSummary = new GetMetricsSummary(readModel, deps.clock);
  return {
    module: {
      name: 'metrics',
      routes: (api) => registerMetricsRoutes(api, getSummary),
      backgroundTasks: () => [createSocGaugesTask(readModel, deps.clock, deps.logger)],
    },
  };
}
