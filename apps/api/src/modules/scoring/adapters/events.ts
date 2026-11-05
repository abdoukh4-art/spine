import { parseEventPayload } from '@spine/shared-schema';
import type { EventHandler } from '../../../platform/events/types.js';
import type { Logger } from '../../../platform/logger.js';
import type { ScoringApplication } from '../application/scoring-app.js';
import type { ScoringMetrics } from './metrics.js';

/** Stable subscriber name: part of the delivery job id. */
export const ON_ALERT_ENRICHED = 'scoring.on-alert-enriched';

/**
 * `alert.enriched` → score → upsert `alert_scores` + `alert.scored` in one transaction,
 * only when the score is new or changed (idempotent per alert + ruleset version, ADR-0042).
 */
export function onAlertEnriched(
  app: ScoringApplication,
  metrics: ScoringMetrics,
  logger: Logger,
): EventHandler<'alert.enriched'> {
  return {
    name: ON_ALERT_ENRICHED,
    eventType: 'alert.enriched',
    handle: async (event) => {
      const { alert, enrichments } = parseEventPayload('alert.enriched', event.payload);
      const { explanation, published } = await app.scoreSnapshot(
        alert,
        enrichments,
        new Date(event.occurredAt),
      );
      if (published) metrics.recordScored(explanation);
      logger.info(
        {
          alertId: alert.id,
          score: explanation.score,
          severity: explanation.severity,
          rulesetVersion: explanation.rulesetVersion,
          published,
        },
        published ? 'scoring: alert scored' : 'scoring: score unchanged, nothing published',
      );
    },
  };
}
