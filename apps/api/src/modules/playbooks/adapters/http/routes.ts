import {
  ApprovalDecisionSchema,
  ApprovalSchema,
  ApprovalStatusSchema,
  IdSchema,
  pageSchema,
  PlaybookDefinitionSchema,
  PlaybookIdSchema,
  PlaybookRecordSchema,
  PlaybookSourceRequestSchema,
  PlaybookSummarySchema,
  ProblemSchema,
  RunDetailSchema,
  RunListQuerySchema,
  RunStatusSchema,
  RunSummarySchema,
  SIMULATED_ACTION_KINDS,
  SimulatedActionSchema,
  StartRunRequestSchema,
} from '@spine/shared-schema';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser } from '../../../../platform/http/access.js';
import type { ApprovalService } from '../../application/approvals.js';
import type { PlaybookCatalog } from '../../application/catalog.js';
import type { RunService } from '../../application/runs.js';
import type { SimulatedActionReader } from '../../application/ports.js';

/** Route-local request/response schemas (additive to the shared contract). */
const IdParams = z.object({ id: IdSchema });
const PlaybookParams = z.object({ id: PlaybookIdSchema });
const PlaybookGetQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const UpdatePlaybookRequest = z.object({ enabled: z.boolean() });
const ValidateResponse = z.object({ valid: z.literal(true), definition: PlaybookDefinitionSchema });
const RunAccepted = z.object({ runId: IdSchema });
const ApprovalListQuery = z.object({
  status: ApprovalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
const SimulatedActionListQuery = z.object({
  kind: z.enum(SIMULATED_ACTION_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
const problems = { 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema };

/** Dependencies of the HTTP adapter. */
export interface PlaybookRoutesDeps {
  catalog: PlaybookCatalog;
  runs: RunService;
  approvals: ApprovalService;
  simulatedActions: SimulatedActionReader;
}

/** Registers the playbooks module's routes (docs/architecture/api-contract.md). */
export function registerPlaybookRoutes(api: FastifyInstance, deps: PlaybookRoutesDeps): void {
  registerCatalogRoutes(api, deps);
  registerCatalogWriteRoutes(api, deps);
  registerRunRoutes(api, deps);
  registerApprovalRoutes(api, deps);
}

function registerCatalogRoutes(api: FastifyInstance, { catalog }: PlaybookRoutesDeps): void {
  const app = api.withTypeProvider<ZodTypeProvider>();
  const tags = ['playbooks'];
  app.get(
    '/playbooks',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags,
        summary: 'List playbooks (latest version of each)',
        response: { 200: z.array(PlaybookSummarySchema) },
      },
    },
    () => catalog.list(),
  );
  app.get(
    '/playbooks/:id',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags,
        summary: 'Get a playbook version (latest by default)',
        params: PlaybookParams,
        querystring: PlaybookGetQuery,
        response: { 200: PlaybookRecordSchema, ...problems },
      },
    },
    (req) => catalog.get(req.params.id, req.query.version),
  );
  app.post(
    '/playbooks/validate',
    {
      config: { access: { role: 'analyst' } },
      schema: {
        tags,
        summary: 'Validate playbook source without storing it',
        body: PlaybookSourceRequestSchema,
        response: { 200: ValidateResponse, 422: ProblemSchema, ...problems },
      },
    },
    (req) => ({
      valid: true as const,
      definition: catalog.validate(req.body.source, req.body.format),
    }),
  );
}

function registerCatalogWriteRoutes(api: FastifyInstance, { catalog }: PlaybookRoutesDeps): void {
  const app = api.withTypeProvider<ZodTypeProvider>();
  const tags = ['playbooks'];
  app.post(
    '/playbooks',
    {
      config: { access: { role: 'admin' } },
      schema: {
        tags,
        summary: 'Publish a new immutable playbook version',
        body: PlaybookSourceRequestSchema,
        response: {
          201: PlaybookRecordSchema,
          409: ProblemSchema,
          422: ProblemSchema,
          ...problems,
        },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const record = await catalog.publish(req.body.source, req.body.format, {
        id: user.id,
        requestId: req.id,
      });
      return reply.status(201).send(record);
    },
  );
  app.patch(
    '/playbooks/:id',
    {
      config: { access: { role: 'admin' } },
      schema: {
        tags,
        summary: 'Enable or disable automatic triggering',
        params: PlaybookParams,
        body: UpdatePlaybookRequest,
        response: { 200: PlaybookSummarySchema, ...problems },
      },
    },
    (req) =>
      catalog.setEnabled(req.params.id, req.body.enabled, {
        id: requireUser(req).id,
        requestId: req.id,
      }),
  );
}

function registerRunRoutes(api: FastifyInstance, { runs }: PlaybookRoutesDeps): void {
  const app = api.withTypeProvider<ZodTypeProvider>();
  const tags = ['runs'];
  app.post(
    '/playbooks/:id/runs',
    {
      config: { access: { role: 'analyst' } },
      schema: {
        tags,
        summary: 'Start a run of the latest playbook version for an alert',
        params: PlaybookParams,
        body: StartRunRequestSchema,
        response: { 202: RunAccepted, ...problems },
      },
    },
    async (req, reply) => {
      const runId = await runs.startManual({
        playbookId: req.params.id,
        alertId: req.body.alertId,
        dryRun: req.body.dryRun,
        actorId: requireUser(req).id,
      });
      return reply.status(202).send({ runId });
    },
  );
  app.get(
    '/runs',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags,
        summary: 'List runs, newest first',
        querystring: RunListQuerySchema,
        response: { 200: pageSchema(RunSummarySchema), ...problems },
      },
    },
    (req) => {
      const status = RunStatusSchema.safeParse(req.query.status);
      return runs.list({
        limit: req.query.limit,
        ...(req.query.playbookId ? { playbookId: req.query.playbookId } : {}),
        ...(req.query.alertId ? { alertId: req.query.alertId } : {}),
        ...(status.success ? { status: status.data } : {}),
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
      });
    },
  );
  app.get(
    '/runs/:id',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags,
        summary: 'Run detail: timeline events and derived step states',
        params: IdParams,
        response: { 200: RunDetailSchema, ...problems },
      },
    },
    (req) => runs.detail(req.params.id),
  );
  app.post(
    '/runs/:id/cancel',
    {
      config: { access: { role: 'analyst' } },
      schema: {
        tags,
        summary: 'Cancel a run that has not finished',
        params: IdParams,
        response: { 202: RunSummarySchema, 409: ProblemSchema, ...problems },
      },
    },
    async (req, reply) => {
      const summary = await runs.cancel(req.params.id, {
        id: requireUser(req).id,
        requestId: req.id,
      });
      return reply.status(202).send(summary);
    },
  );
}

function registerApprovalRoutes(api: FastifyInstance, deps: PlaybookRoutesDeps): void {
  const app = api.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/approvals',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['approvals'],
        summary: 'List approval requests',
        querystring: ApprovalListQuery,
        response: { 200: pageSchema(ApprovalSchema), ...problems },
      },
    },
    (req) =>
      deps.approvals.list({
        limit: req.query.limit,
        ...(req.query.status ? { status: req.query.status } : {}),
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
      }),
  );
  app.post(
    '/approvals/:id/decision',
    {
      config: { access: { role: 'analyst' } },
      schema: {
        tags: ['approvals'],
        summary: 'Approve or reject a pending approval',
        params: IdParams,
        body: ApprovalDecisionSchema,
        response: { 200: ApprovalSchema, 409: ProblemSchema, ...problems },
      },
    },
    (req) => {
      const user = requireUser(req);
      return deps.approvals.decide(req.params.id, req.body, {
        id: user.id,
        role: user.role,
        requestId: req.id,
      });
    },
  );
  app.get(
    '/simulated-actions',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['simulated-actions'],
        summary: 'What the simulated firewall, ticketing and chat integrations "did"',
        querystring: SimulatedActionListQuery,
        response: { 200: pageSchema(SimulatedActionSchema), ...problems },
      },
    },
    (req) =>
      deps.simulatedActions.list({
        limit: req.query.limit,
        ...(req.query.kind ? { kind: req.query.kind } : {}),
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
      }),
  );
}
