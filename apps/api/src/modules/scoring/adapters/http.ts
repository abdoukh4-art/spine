import {
  RulesetSchema,
  ScoreExplanationSchema,
  ScorePreviewRequestSchema,
  type Alert,
  type CanonicalAlert,
} from '@spine/shared-schema';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Clock } from '../../../platform/runtime.js';
import type { ScoringApplication } from '../application/scoring-app.js';

/** Placeholder identity for a previewed alert that was never stored. */
const PREVIEW_ALERT_ID = '00000000-0000-7000-8000-000000000000';

/**
 * A preview may send a bare canonical alert. Fill the stored-alert fields with neutral
 * values: no duplicates, status `new`, received now.
 */
export function toPreviewAlert(alert: Alert | CanonicalAlert, now: Date): Alert {
  if ('id' in alert) return alert;
  const at = now.toISOString();
  return {
    ...alert,
    id: PREVIEW_ALERT_ID,
    fingerprint: '0'.repeat(64),
    status: 'new',
    receivedAt: at,
    lastSeenAt: at,
    duplicateCount: 0,
  };
}

/** HTTP routes of the scoring module (mounted under `/api/v1`). */
export function scoringRoutes(api: FastifyInstance, app: ScoringApplication, clock: Clock): void {
  const typed = api.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/scoring/ruleset',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['scoring'],
        summary: 'The active scoring ruleset (version, baseline and rules), for transparency',
        security: [{ bearerAuth: [] }],
        response: { 200: RulesetSchema },
      },
    },
    () => app.activeRuleset(),
  );

  typed.post(
    '/scoring/preview',
    {
      config: { access: { role: 'analyst' } },
      schema: {
        tags: ['scoring'],
        summary: 'Score an alert with the active ruleset without storing anything',
        description:
          'Send an alert (stored Alert or CanonicalAlertInput) and enrichment results; get the ' +
          'full ScoreExplanation back. Useful when authoring or tuning rules.',
        security: [{ bearerAuth: [] }],
        body: ScorePreviewRequestSchema,
        response: { 200: ScoreExplanationSchema },
      },
    },
    (request) =>
      app.preview(toPreviewAlert(request.body.alert, clock.now()), request.body.enrichments),
  );
}
