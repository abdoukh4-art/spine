import { MetricsQuerySchema, MetricsSummarySchema } from '@spine/shared-schema';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { GetMetricsSummary } from '../application/get-metrics-summary.js';

/** HTTP adapter: `GET /api/v1/metrics/summary` (viewer). */
export function registerMetricsRoutes(api: FastifyInstance, getSummary: GetMetricsSummary): void {
  api.withTypeProvider<ZodTypeProvider>().get(
    '/metrics/summary',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['metrics'],
        summary:
          'SOC metrics: alert volume, MTTD, MTTR, playbook success rate and latency (ADR-0026)',
        security: [{ bearerAuth: [] }],
        querystring: MetricsQuerySchema,
        response: { 200: MetricsSummarySchema },
      },
    },
    (request) => getSummary.execute(request.query),
  );
}
