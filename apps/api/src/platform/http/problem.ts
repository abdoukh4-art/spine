import { PROBLEM_TYPE_BASE, type Problem } from '@spine/shared-schema';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError, OverloadedError } from '../errors.js';

/**
 * Maps every error to an RFC 9457 problem document (ADR-0024).
 * Rule: clients get a stable `type` slug and a safe message. Internals (stack traces,
 * SQL, library messages) are only ever logged, never returned.
 */

const STATUS_BY_SLUG: Record<string, number> = {
  'validation-error': 400,
  unauthenticated: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'idempotency-key-reused': 409,
  unprocessable: 422,
  'playbook-invalid': 422,
  'rate-limited': 429,
  overloaded: 503,
  internal: 500,
};

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function problem(
  slug: string,
  status: number,
  detail: string | undefined,
  instance: string,
  errors?: { path: string; message: string }[],
): Problem {
  return {
    type: `${PROBLEM_TYPE_BASE}${slug}`,
    title: TITLES[status] ?? 'Error',
    status,
    ...(detail !== undefined ? { detail } : {}),
    instance,
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
}

function send(reply: FastifyReply, body: Problem): FastifyReply {
  return reply.status(body.status).type('application/problem+json').send(body);
}

function toProblem(error: unknown, request: FastifyRequest, reply: FastifyReply): Problem {
  const id = request.id;
  if (error instanceof AppError) {
    const status = STATUS_BY_SLUG[error.slug] ?? 400;
    if (error instanceof OverloadedError) {
      void reply.header('retry-after', String(error.retryAfterSeconds));
    }
    return problem(error.slug, status, error.message, id, error.details);
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    // Typed locally: the library's type re-exports fastify/types/schema, which some tools can't resolve.
    const validation = error.validation as readonly { instancePath: string; message?: string }[];
    const errors = validation.map((v) => ({
      path: `${error.validationContext ?? 'request'}${v.instancePath.replaceAll('/', '.')}`,
      message: v.message ?? 'invalid',
    }));
    return problem('validation-error', 400, 'Request validation failed', id, errors);
  }
  if (isResponseSerializationError(error)) {
    return problem('internal', 500, undefined, id);
  }
  const fe = error as Partial<FastifyError>;
  const status = typeof fe.statusCode === 'number' ? fe.statusCode : 500;
  if (status === 429) return problem('rate-limited', 429, 'Too many requests', id);
  if (status >= 400 && status < 500) {
    // Fastify's own 4xx errors (bad JSON, body too large, unsupported media type): safe to describe.
    return problem('validation-error', status, fe.message, id);
  }
  return problem('internal', 500, undefined, id);
}

/** Installs the error and not-found handlers. */
export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const body = toProblem(error, request, reply);
    if (body.status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.info({ problem: body.type, status: body.status }, 'request rejected');
    }
    return send(reply, body);
  });
  app.setNotFoundHandler((request, reply) =>
    send(
      reply,
      problem(
        'not-found',
        404,
        `No route for ${request.method} ${request.url.split('?')[0] ?? ''}`,
        request.id,
      ),
    ),
  );
}
