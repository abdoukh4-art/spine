import type { PlatformDeps, SpineModule } from '../../platform/module.js';
import { registerAlertRoutes } from './adapters/http/routes.js';
import { PostgresAlertRepository } from './adapters/postgres/alert-repository.js';
import { PostgresCaseRepository } from './adapters/postgres/case-repository.js';
import { kyselyTransactionRunner } from './adapters/postgres/transaction.js';
import { AlertsService } from './application/alerts-service.js';
import { CasesService } from './application/cases-service.js';
import type { AlertDetailSources } from './application/ports.js';
import { projectScoreHandler } from './application/project-score.js';
import type { AlertsPublicApi } from './public-api.js';

export type { AlertDetailSources } from './application/ports.js';

/** Options the composition root passes in (ports implemented by other modules). */
export interface AlertsModuleOptions {
  detailSources: AlertDetailSources;
}

/**
 * Alerts/Cases module composition (docs/modules/alerts.md): wires the Postgres adapters into
 * the use cases and contributes routes and the `alerts.project-score` subscriber.
 */
export function createAlertsModule(
  deps: PlatformDeps,
  options: AlertsModuleOptions,
): { module: SpineModule; api: AlertsPublicApi } {
  const alertRepo = new PostgresAlertRepository(deps.db);
  const caseRepo = new PostgresCaseRepository(deps.db);
  const tx = kyselyTransactionRunner(deps.db);
  const alerts = new AlertsService({
    alerts: alertRepo,
    cases: caseRepo,
    tx,
    events: deps.events,
    clock: deps.clock,
    detailSources: options.detailSources,
    db: deps.db,
  });
  const cases = new CasesService({
    alerts: alertRepo,
    cases: caseRepo,
    tx,
    clock: deps.clock,
    ids: deps.ids,
    db: deps.db,
  });
  return {
    api: alerts,
    module: {
      name: 'alerts',
      routes: (api) => registerAlertRoutes(api, { alerts, cases }),
      subscribers: () => [projectScoreHandler(alertRepo)],
    },
  };
}
