import type { Redis } from 'ioredis';
import type { Config } from './platform/config.js';
import { createDatabase, pingDatabase, type Db } from './platform/db/database.js';
import { migrationsUpToDate } from './platform/db/migrator.js';
import { OutboxEventPublisher } from './platform/events/outbox.js';
import { EventSubscriptions, type EventPublisher } from './platform/events/types.js';
import type { Authenticator } from './platform/http/access.js';
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

  const auth = createAuthModule(deps);
  const alerts = createAlertsModule(deps);
  const ingestion = createIngestionModule(deps);
  const enrichment = createEnrichmentModule(deps);
  const scoring = createScoringModule(deps);
  const playbooks = createPlaybooksModule(deps, {
    // INTEGRATION: replace with enrichment public API (enrichAlert) in Phase 2.
    enrichment: { enrich: () => Promise.resolve([]) },
    // INTEGRATION: replace with scoring public API (scoreAndStore / preview when !persist) in Phase 2.
    scoring: { score: () => Promise.resolve(null) },
    // INTEGRATION: replace with alerts public API (setStatus, mapping ConflictError to changed:false) in Phase 2.
    alertStatus: {
      setStatus: () => Promise.resolve({ changed: false, reason: 'alerts module not wired yet' }),
    },
    // INTEGRATION: replace with alerts.get + enrichment.getForAlert + scoring.getForAlert in Phase 2.
    alertSnapshot: { get: () => Promise.resolve(null) },
    audit: auth.api.audit,
  });
  const metrics = createMetricsModule(deps);

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

  return { deps, modules, subscriptions, authenticator: auth.api.authenticator, readinessChecks };
}
