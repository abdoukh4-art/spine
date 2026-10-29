import type { Ruleset } from '@spine/shared-schema';
import type { PlatformDeps, SpineModule } from '../../platform/module.js';
import { onAlertEnriched } from './adapters/events.js';
import { scoringRoutes } from './adapters/http.js';
import { createScoringMetrics, type ScoringMetrics } from './adapters/metrics.js';
import { PostgresScoreRepository } from './adapters/postgres.js';
import { loadRuleset, rulesetPath } from './adapters/ruleset-loader.js';
import { ScoringApplication } from './application/scoring-app.js';
import type { ScoringPublicApi } from './public-api.js';

/** Optional overrides (tests). */
export interface ScoringModuleOptions {
  /** Use this ruleset instead of loading `CONFIG_DIR/SCORING_RULESET_FILE`. */
  ruleset?: Ruleset;
  metrics?: ScoringMetrics;
}

/**
 * Scoring module composition. Loads and validates the ruleset at startup and **throws** if
 * it is invalid (fail fast, ADR-0046). See docs/modules/scoring.md.
 */
export function createScoringModule(
  deps: PlatformDeps,
  options: ScoringModuleOptions = {},
): { module: SpineModule; api: ScoringPublicApi } {
  const ruleset = options.ruleset ?? loadRuleset(rulesetPath(deps.config));
  const metrics = options.metrics ?? createScoringMetrics();
  const app = new ScoringApplication({
    ruleset,
    repository: new PostgresScoreRepository(deps.db, deps.events),
    clock: deps.clock,
  });
  deps.logger.info(
    { rulesetVersion: ruleset.version, rules: ruleset.rules.length },
    'scoring: ruleset loaded',
  );
  return {
    api: app,
    module: {
      name: 'scoring',
      routes: (api) => scoringRoutes(api, app, deps.clock),
      subscribers: () => [onAlertEnriched(app, metrics, deps.logger)],
    },
  };
}
