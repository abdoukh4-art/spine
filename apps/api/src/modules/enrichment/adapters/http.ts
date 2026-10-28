import {
  AlertIdParamsSchema,
  ProviderStatusSchema,
  ReEnrichResponseSchema,
} from '@spine/shared-schema';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { EnrichmentApplication } from '../application/enrichment-app.js';

/** HTTP routes of the enrichment module (mounted under `/api/v1`). */
export function enrichmentRoutes(api: FastifyInstance, app: EnrichmentApplication): void {
  const typed = api.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/enrichment/providers',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['enrichment'],
        summary: 'Enrichment providers with circuit-breaker state and bulkhead usage',
        description:
          'State is per process: this reflects the API process, whose breakers only see ' +
          're-enrichment calls made through it (the worker has its own).',
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(ProviderStatusSchema) },
      },
    },
    () => app.providerStatus(),
  );

  typed.post(
    '/alerts/:id/enrich',
    {
      config: { access: { role: 'analyst' } },
      schema: {
        tags: ['enrichment'],
        summary: 'Re-run enrichment for an alert (e.g. after a provider outage)',
        description:
          'Runs every provider again, stores the results and publishes alert.enriched, so the ' +
          'alert is re-scored asynchronously (hence 202). Returns the merged stored enrichment.',
        security: [{ bearerAuth: [] }],
        params: AlertIdParamsSchema,
        response: { 202: ReEnrichResponseSchema },
      },
    },
    async (request, reply) => {
      const enrichments = await app.reEnrichById(request.params.id);
      return reply.status(202).send({ alertId: request.params.id, enrichments });
    },
  );
}
