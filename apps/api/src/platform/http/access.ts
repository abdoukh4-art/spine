import { roleSatisfies, type Role } from '@spine/shared-schema';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthenticatedError } from '../errors.js';

/**
 * Access control at the HTTP edge (ADR-0017).
 *
 * Every route MUST declare `config.access`. A global preHandler enforces it, and a test
 * walks all routes to assert none is missing (deny-by-default). Policies:
 * - `'public'`               — no authentication (health, login, refresh).
 * - `{ role: 'viewer' | 'analyst' | 'admin' }` — authenticated user with at least that role.
 * - `'webhook'`             — the route authenticates itself (HMAC); no user principal.
 */
export type AccessPolicy = 'public' | 'webhook' | { role: Role };

export type Principal =
  | { kind: 'user'; id: string; role: Role; email: string }
  | { kind: 'webhook'; sourceId: string };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the access-control hook for user routes; null for public routes. */
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    access?: AccessPolicy;
  }
}

/** Port implemented by the auth module: turns a bearer token into a principal. */
export interface Authenticator {
  /** @throws UnauthenticatedError when the token is invalid, expired or the user is disabled. */
  authenticate(bearerToken: string): Promise<Extract<Principal, { kind: 'user' }>>;
}

/** Authenticator used until the auth module is wired: rejects every token. */
export const rejectAllAuthenticator: Authenticator = {
  authenticate: () => Promise.reject(new UnauthenticatedError('authentication is not configured')),
};

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/** Registers the global access-control preHandler. */
export function registerAccessControl(app: FastifyInstance, authenticator: Authenticator): void {
  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (request) => {
    // Unmatched routes (404) have no config; let the not-found handler respond.
    if (!request.routeOptions.url) return;
    const access = request.routeOptions.config.access;
    if (access === undefined) {
      throw new ForbiddenError(`route ${request.routeOptions.url} declares no access policy`);
    }
    if (access === 'public' || access === 'webhook') return;
    const token = bearerToken(request);
    if (!token) throw new UnauthenticatedError('missing bearer token');
    const principal = await authenticator.authenticate(token);
    if (!roleSatisfies(principal.role, access.role)) {
      throw new ForbiddenError(`requires role ${access.role}`);
    }
    request.principal = principal;
  });
}

/** Returns the authenticated user principal or throws (for handlers on role-protected routes). */
export function requireUser(request: FastifyRequest): Extract<Principal, { kind: 'user' }> {
  const p = request.principal;
  if (p?.kind !== 'user') throw new UnauthenticatedError('authentication required');
  return p;
}
