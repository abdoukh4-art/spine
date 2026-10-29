import type { DomainEvent } from '@spine/shared-schema';
import type { EventHandler } from '../../../platform/events/types.js';
import type { AlertRepository } from './ports.js';

/** Stable subscriber name: part of the BullMQ job id, so never rename it (ADR-0009). */
export const PROJECT_SCORE_SUBSCRIBER = 'alerts.project-score';

/**
 * Projects `alert.scored` onto the `alerts.score` / `alerts.severity` columns, which the queue
 * sorts and filters on. Idempotent: re-applying the same event writes the same values, and an
 * older score delivered after a newer one is ignored thanks to the `scored_at` guard (ADR-0038).
 */
export function projectScoreHandler(alerts: AlertRepository): EventHandler<'alert.scored'> {
  return {
    name: PROJECT_SCORE_SUBSCRIBER,
    eventType: 'alert.scored',
    async handle(event: DomainEvent<'alert.scored'>): Promise<void> {
      const { alert, score } = event.payload;
      await alerts.projectScore(alert.id, {
        score: score.score,
        severity: score.severity,
        computedAt: score.computedAt,
      });
    },
  };
}
