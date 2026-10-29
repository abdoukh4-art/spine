import type { Redis } from 'ioredis';
import type { Config } from './platform/config.js';
import { createDatabase, pingDatabase, type Db } from './platform/db/database.js';
import { migrationsUpToDate } from './platform/db/migrator.js';
import { OutboxEventPublisher } from './platform/events/outbox.js';
import { EventSubscriptions, type EventPublisher } from './platform/events/types.js';
import type { Authenticator } from './platform/http/access.js';
import { ConflictError } from './platform/errors.js';
import { createLogger, type Logger } from './platform/logger.js';
import type { PlatformDeps, SpineModule } from './platform/module.js';
import { systemClock, uuidV7Generator, type Clock, type IdGenerator } from './platform/runtime.js';
import { pingRedis } from './platform/queue/bullmq.js';
import { createAlertsModule } from './modules/alerts/index.js';
import { createAuthModule } from './modules/auth/index.js';
import { createEnrichmentModule } from './modules/enrichment/index.js';
import { createIngestionModule } from './modules/ingestion/index.js';
import { createMetricsModule } from './modules/metrics/index.js';
import { createPlaybooksModule } from './modules/playbooks/index.js';
import { createScoringModule } from './modules/scoring/index.js';
import type { AlertsPublicApi } from './modules/alerts/public-api.js';
import type { EnrichmentPublicApi } from './modules/enrichment/public-api.js';
import type { PlaybooksGateways } from './modules/playbooks/index.js';
import type { ScoringPublicApi } from './modules/scoring/public-api.js';

/**
 * Composition root (ADR-0002): the ONE place that knows every module and wires their
 * public APIs together. Cross-module cycles (e.g. alerts ⇄ playbooks) are broken here
 * with late-bound closures, so modules themselves only depend on ports.
 */
export interface Application {
  deps: PlatformDeps;
  modules: SpineModule[];
  subscriptions: EventSubscriptions;
  authenticator: Authenticator;
  readinessChecks: Record<string, () => Promise<boolean>>;
  /** The Alerts public API, for admin processes such as the demo seeder. */
  alertsApi: AlertsPublicApi;
}

export interface ApplicationOverrides {
  db?: Db;
  redis?: Redis | null;
  logger?: Logger;
  clock?: Clock;
  ids?: IdGenerator;
  events?: EventPublisher;
  traceparent?: () => string | undefined;
}

export function createApplication(
  config: Config,
  overrides: ApplicationOverrides = {},
): Application {
  const logger = overrides.logger ?? createLogger(config);
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? uuidV7Generator;
  const db =
    overrides.db ??
    createDatabase({
      connectionString: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      applicationName: config.SERVICE_NAME,
    });
  const redis = overrides.redis ?? null;
  const events = overrides.events ?? new OutboxEventPublisher(ids, clock, overrides.traceparent);
  const deps: PlatformDeps = { config, logger, db, clock, ids, events, redis };

  // Modules are created in dependency order. Where two modules need each other (alerts ⇄
  // playbooks, alerts ⇄ enrichment), the earlier one gets a late-bound closure: the
  // referenced module exists by the time any request or event reaches the closure.
  const auth = createAuthModule(deps);
  const alerts = createAlertsModule(deps, {
    detailSources: {
      enrichmentsFor: (alertId) => enrichment.api.getForAlert(alertId),
      scoreFor: (alertId) => scoring.api.getForAlert(alertId),
      runsFor: (alertId) => playbooks.api.runsForAlert(alertId),
    },
  });
  const ingestion = createIngestionModule(deps, { alerts: alerts.api });
  const enrichment = createEnrichmentModule(deps, { alertLookup: alerts.api });
  const scoring = createScoringModule(deps);
  const playbooks = createPlaybooksModule(deps, {
    enrichment: {
      enrich: (alert, options) => enrichment.api.enrichAlert(alert, options),
    },
    scoring: {
      score: (alert, enrichments, { persist }) =>
        persist
          ? scoring.api.scoreAndStore(alert, enrichments)
          : Promise.resolve(scoring.api.preview(alert, enrichments)),
    },
    ...alertGatewaysForPlaybooks(alerts.api, enrichment.api, scoring.api),
    audit: auth.api.audit,
  });
  const metrics = createMetricsModule(deps, {
    alertStats: ({ from, to }) => alerts.api.statsReceivedBetween(from, to),
    runStats: ({ from, to }) => playbooks.api.runStatsBetween(from, to),
  });

  const modules = [auth, alerts, ingestion, enrichment, scoring, playbooks, metrics].map(
    (m) => m.module,
  );

  const subscriptions = new EventSubscriptions();
  for (const m of modules) for (const h of m.subscribers?.() ?? []) subscriptions.register(h);

  const readinessChecks: Record<string, () => Promise<boolean>> = {
    database: () => pingDatabase(db),
    migrations: () => migrationsUpToDate(db, config.MIGRATIONS_DIR),
    ...(redis ? { redis: () => pingRedis(redis) } : {}),
  };
  for (const m of modules) Object.assign(readinessChecks, m.readinessChecks?.() ?? {});

  return {
    deps,
    modules,
    subscriptions,
    authenticator: auth.api.authenticator,
    readinessChecks,
    alertsApi: alerts.api,
  };
}

/**
 * Adapts the Alerts, Enrichment and Scoring public APIs to the two alert-facing ports of
 * the Playbooks module (`set_status` steps and snapshots for manual runs).
 */
function alertGatewaysForPlaybooks(
  alerts: AlertsPublicApi,
  enrichment: EnrichmentPublicApi,
  scoring: ScoringPublicApi,
): Pick<PlaybooksGateways, 'alertStatus' | 'alertSnapshot'> {
  return {
    alertStatus: {
      setStatus: async (alertId, status) => {
        try {
          if (!(await alerts.get(alertId)))
            return { changed: false, reason: `alert ${alertId} not found` };
          await alerts.setStatus(alertId, status, null);
          return { changed: true };
        } catch (err) {
          // Illegal transitions are reported to the playbook, not thrown (port contract).
          if (err instanceof ConflictError) return { changed: false, reason: err.message };
          throw err;
        }
      },
    },
    alertSnapshot: {
      get: async (alertId) => {
        const alert = await alerts.get(alertId);
        if (!alert) return null;
        const [enrichments, score] = await Promise.all([
          enrichment.getForAlert(alertId),
          scoring.getForAlert(alertId),
        ]);
        return { alert, enrichments, score };
      },
    },
  };
}
