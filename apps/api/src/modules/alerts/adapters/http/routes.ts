import {
  AlertDetailSchema,
  AlertListQuerySchema,
  AlertSummarySchema,
  CaseDetailSchema,
  CaseListQuerySchema,
  CaseSchema,
  CreateCaseRequestSchema,
  IdSchema,
  pageSchema,
  UpdateAlertRequestSchema,
  UpdateCaseRequestSchema,
} from '@spine/shared-schema';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser } from '../../../../platform/http/access.js';
import type { AlertsService } from '../../application/alerts-service.js';
import type { CasesService } from '../../application/cases-service.js';

const IdParams = z.object({ id: IdSchema });

/** Registers `/alerts` read/triage routes and `/cases` routes (docs/architecture/api-contract.md). */
export function registerAlertRoutes(
  api: FastifyInstance,
  services: { alerts: AlertsService; cases: CasesService },
): void {
  const app = api.withTypeProvider<ZodTypeProvider>();
  const { alerts, cases } = services;

  app.get(
    '/alerts',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['alerts'],
        summary: 'List alerts (filters + keyset pagination)',
        querystring: AlertListQuerySchema,
        response: { 200: pageSchema(AlertSummarySchema) },
      },
    },
    (req) => alerts.list(req.query),
  );

  app.get(
    '/alerts/:id',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['alerts'],
        summary: 'Alert detail with enrichments, score explanation and playbook runs',
        params: IdParams,
        response: { 200: AlertDetailSchema },
      },
    },
    (req) => alerts.detail(req.params.id),
  );

  app.patch(
    '/alerts/:id',
    {
      config: { access: { role: 'analyst' } },
      schema: {
        tags: ['alerts'],
        summary: 'Triage an alert: status (validated transitions), assignee, case',
        params: IdParams,
        body: UpdateAlertRequestSchema,
        response: { 200: AlertSummarySchema },
      },
    },
    (req) => alerts.update(req.params.id, req.body, requireUser(req).id),
  );

  registerCaseRoutes(api, cases);
}

/** Registers `/cases` routes. */
function registerCaseRoutes(api: FastifyInstance, cases: CasesService): void {
  const app = api.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/cases',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['cases'],
        summary: 'List cases, newest first',
        querystring: CaseListQuerySchema,
        response: { 200: pageSchema(CaseSchema) },
      },
    },
    (req) => cases.list(req.query),
  );

  app.post(
    '/cases',
    {
      config: { access: { role: 'analyst' } },
      schema: {
        tags: ['cases'],
        summary: 'Create a case and link alerts to it',
        body: CreateCaseRequestSchema,
        response: { 201: CaseSchema },
      },
    },
    async (req, reply) => {
      const created = await cases.create(req.body, requireUser(req).id);
      return reply.status(201).send(created);
    },
  );

  app.get(
    '/cases/:id',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['cases'],
        summary: 'A case with its linked alerts',
        params: IdParams,
        response: { 200: CaseDetailSchema },
      },
    },
    (req) => cases.get(req.params.id),
  );

  app.patch(
    '/cases/:id',
    {
      config: { access: { role: 'analyst' } },
      schema: {
        tags: ['cases'],
        summary: 'Update a case; link or unlink alerts',
        params: IdParams,
        body: UpdateCaseRequestSchema,
        response: { 200: CaseSchema },
      },
    },
    (req) => cases.update(req.params.id, req.body),
  );
}
