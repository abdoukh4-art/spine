import cookie from '@fastify/cookie';
import { LoginRequestSchema, TokenResponseSchema, UserSchema } from '@spine/shared-schema';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ForbiddenError } from '../../../../platform/errors.js';
import { requireUser } from '../../../../platform/http/access.js';
import { InvalidRefreshTokenError, TooManyAttemptsError } from '../../application/errors.js';
import type { SessionService, SessionTokens } from '../../application/sessions.js';
import type { UserAdminService } from '../../application/users.js';
import { checkCsrf, CSRF_HEADER } from '../../domain/csrf-policy.js';
import { presentTokens, presentUser, requestContext } from './presenters.js';

/** Name of the refresh-token cookie (ADR-0016). */
export const REFRESH_COOKIE = 'spine_refresh';
/** The cookie is only ever sent to the auth endpoints, never to the rest of the API. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** What the session routes need. */
export interface SessionRoutesDeps {
  sessions: SessionService;
  users: UserAdminService;
  allowedOrigins: readonly string[];
  cookieSecure: boolean;
  refreshTtlSeconds: number;
}

/**
 * `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`.
 * Registered in their own encapsulated context so `@fastify/cookie` stays local to auth.
 */
export async function registerSessionRoutes(
  parent: FastifyInstance,
  deps: SessionRoutesDeps,
): Promise<void> {
  await parent.register(async (scope) => {
    await scope.register(cookie);
    const cookies = new RefreshCookie(deps.cookieSecure, deps.refreshTtlSeconds);
    registerLogin(scope, deps, cookies);
    registerRefresh(scope, deps, cookies);
    registerLogout(scope, deps, cookies);
    registerMe(scope, deps);
  });
}

/** Sets and clears the `spine_refresh` cookie with the attributes ADR-0016 requires. */
class RefreshCookie {
  constructor(
    private readonly secure: boolean,
    private readonly maxAgeSeconds: number,
  ) {}

  set(reply: FastifyReply, raw: string): void {
    void reply.setCookie(REFRESH_COOKIE, raw, { ...this.attributes(), maxAge: this.maxAgeSeconds });
  }

  clear(reply: FastifyReply): void {
    void reply.clearCookie(REFRESH_COOKIE, this.attributes());
  }

  /** HttpOnly: unreadable by JavaScript (XSS). Strict: never sent on cross-site requests. */
  private attributes() {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict' as const,
      path: REFRESH_COOKIE_PATH,
    };
  }
}

/** Successful login/refresh: cookie, `no-store`, and the principal for the audit hook. */
function respondWithSession(
  request: FastifyRequest,
  reply: FastifyReply,
  cookies: RefreshCookie,
  tokens: SessionTokens,
) {
  cookies.set(reply, tokens.refreshToken);
  // RFC 6749 §5.1: responses carrying tokens must not be cached.
  void reply.header('cache-control', 'no-store');
  request.principal = {
    kind: 'user',
    id: tokens.user.id,
    role: tokens.user.role,
    email: tokens.user.email,
  };
  return presentTokens(tokens);
}

function registerLogin(scope: FastifyInstance, deps: SessionRoutesDeps, cookies: RefreshCookie) {
  scope.withTypeProvider<ZodTypeProvider>().post(
    '/auth/login',
    {
      config: { access: 'public' },
      schema: {
        tags: ['auth'],
        summary: 'Log in with email and password',
        description:
          'Rate limited per IP and per username (429 + Retry-After). Every failure returns 401 "invalid credentials". Sets the `spine_refresh` cookie.',
        body: LoginRequestSchema,
        response: { 200: TokenResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { email, password } = request.body;
        const tokens = await deps.sessions.login(email, password, requestContext(request));
        return respondWithSession(request, reply, cookies, tokens);
      } catch (err) {
        if (err instanceof TooManyAttemptsError) {
          void reply.header('retry-after', String(err.retryAfterSeconds));
        }
        throw err;
      }
    },
  );
}

function registerRefresh(scope: FastifyInstance, deps: SessionRoutesDeps, cookies: RefreshCookie) {
  scope.withTypeProvider<ZodTypeProvider>().post(
    '/auth/refresh',
    {
      config: { access: 'public' },
      preHandler: csrfGuard(deps.allowedOrigins),
      schema: {
        tags: ['auth'],
        summary: 'Rotate the refresh cookie and get a new access token',
        description:
          'Needs the `spine_refresh` cookie, `X-Spine-CSRF: 1` and an allowed Origin. Presenting an already-used token revokes the whole token family.',
        response: { 200: TokenResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const raw = request.cookies[REFRESH_COOKIE];
        const tokens = await deps.sessions.refresh(raw, requestContext(request));
        return respondWithSession(request, reply, cookies, tokens);
      } catch (err) {
        if (err instanceof InvalidRefreshTokenError) cookies.clear(reply);
        throw err;
      }
    },
  );
}

function registerLogout(scope: FastifyInstance, deps: SessionRoutesDeps, cookies: RefreshCookie) {
  scope.withTypeProvider<ZodTypeProvider>().post(
    '/auth/logout',
    {
      config: { access: 'public' },
      preHandler: csrfGuard(deps.allowedOrigins),
      schema: {
        tags: ['auth'],
        summary: 'Log out: revoke the refresh-token family and clear the cookie',
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await deps.sessions.logout(request.cookies[REFRESH_COOKIE], requestContext(request));
      cookies.clear(reply);
      return reply.status(204).send(null);
    },
  );
}

function registerMe(scope: FastifyInstance, deps: SessionRoutesDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/auth/me',
    {
      config: { access: { role: 'viewer' } },
      schema: {
        tags: ['auth'],
        summary: 'The current user',
        security: [{ bearerAuth: [] }],
        response: { 200: UserSchema },
      },
    },
    async (request) => presentUser(await deps.users.me(requireUser(request).id)),
  );
}

/** preHandler enforcing the CSRF policy (ADR-0061) on cookie-authenticated routes. */
function csrfGuard(allowedOrigins: readonly string[]) {
  return (request: FastifyRequest): Promise<void> => {
    const header = request.headers[CSRF_HEADER];
    const verdict = checkCsrf(
      {
        csrfHeader: typeof header === 'string' ? header : undefined,
        origin: request.headers.origin,
      },
      allowedOrigins,
    );
    if (!verdict.ok) {
      request.log.warn({ reason: verdict.reason }, 'csrf check failed');
      return Promise.reject(new ForbiddenError('CSRF check failed'));
    }
    return Promise.resolve();
  };
}
