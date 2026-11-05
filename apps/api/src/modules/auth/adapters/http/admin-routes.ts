import {
  AuditEntrySchema,
  AuditQuerySchema,
  CreateUserRequestSchema,
  IdSchema,
  pageSchema,
  PageQuerySchema,
  UpdateUserRequestSchema,
  UserSchema,
} from '@spine/shared-schema';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AuditStore } from '../../application/ports.js';
import type { UserAdminService } from '../../application/users.js';
import { presentUser } from './presenters.js';

/** What the admin routes need. */
export interface AdminRoutesDeps {
  users: UserAdminService;
  audit: AuditStore;
}

const ADMIN = { access: { role: 'admin' } } as const;
const SECURITY = [{ bearerAuth: [] }];

/** `GET/POST/PATCH /users…` and `GET /audit-log` (admin only, ADR-0017). */
export function registerAdminRoutes(parent: FastifyInstance, deps: AdminRoutesDeps): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/users',
    {
      config: ADMIN,
      schema: {
        tags: ['users'],
        summary: 'List users (sorted by email)',
        security: SECURITY,
        querystring: PageQuerySchema,
        response: { 200: pageSchema(UserSchema) },
      },
    },
    async (request) => {
      const page = await deps.users.list(request.query);
      return { items: page.items.map(presentUser), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/users',
    {
      config: ADMIN,
      schema: {
        tags: ['users'],
        summary: 'Create a user',
        description:
          '409 if the email exists (case-insensitive). 400 if the password fails the policy.',
        security: SECURITY,
        body: CreateUserRequestSchema,
        response: { 201: UserSchema },
      },
    },
    async (request, reply) => {
      const user = await deps.users.create(request.body);
      return reply.status(201).send(presentUser(user));
    },
  );

  app.patch(
    '/users/:id',
    {
      config: ADMIN,
      schema: {
        tags: ['users'],
        summary: 'Change a user’s role, display name, or disabled flag',
        description: '409 if the change would leave no active admin.',
        security: SECURITY,
        params: z.object({ id: IdSchema }),
        body: UpdateUserRequestSchema,
        response: { 200: UserSchema },
      },
    },
    async (request) => presentUser(await deps.users.update(request.params.id, request.body)),
  );

  app.get(
    '/audit-log',
    {
      config: ADMIN,
      schema: {
        tags: ['audit'],
        summary: 'Read the audit log (newest first)',
        description: '`action` is a prefix filter, e.g. `auth.` or `PATCH /api/v1/users`.',
        security: SECURITY,
        querystring: AuditQuerySchema,
        response: { 200: pageSchema(AuditEntrySchema) },
      },
    },
    (request) => {
      const q = request.query;
      return deps.audit.query({
        actorId: q.actorId,
        action: q.action,
        from: q.from === undefined ? undefined : new Date(q.from),
        to: q.to === undefined ? undefined : new Date(q.to),
        limit: q.limit,
        cursor: q.cursor,
      });
    },
  );
}
