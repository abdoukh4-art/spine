import { parseEventPayload } from '@spine/shared-schema';
import type { EventHandler } from '../../../platform/events/types.js';
import type { Logger } from '../../../platform/logger.js';
import type { EnrichmentApplication } from '../application/enrichment-app.js';

/** Stable subscriber name: part of the delivery job id, so never rename it casually. */
export const ON_ALERT_INGESTED = 'enrichment.on-alert-ingested';

/**
 * `alert.ingested` → enrich → upsert + `alert.enriched` in one transaction.
 * Idempotent per event id (ADR-0040). Provider failures never make it throw; only
 * infrastructure errors (database down) do, and then the queue retries the delivery.
 */
export function onAlertIngested(
  app: EnrichmentApplication,
  logger: Logger,
): EventHandler<'alert.ingested'> {
  return {
    name: ON_ALERT_INGESTED,
    eventType: 'alert.ingested',
    handle: async (event) => {
      const { alert } = parseEventPayload('alert.ingested', event.payload);
      const outcome = await app.handleIngested(event.eventId, alert);
      if (outcome.kind === 'duplicate') {
        logger.info(
          { alertId: alert.id, eventId: event.eventId },
          'enrichment: duplicate delivery skipped',
        );
      } else {
        logger.info(
          { alertId: alert.id, lookups: outcome.results, failed: outcome.failed },
          'enrichment: alert enriched',
        );
      }
    },
  };
}
