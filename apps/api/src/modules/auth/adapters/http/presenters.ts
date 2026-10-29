import type { TokenResponse, User } from '@spine/shared-schema';
import type { FastifyRequest } from 'fastify';
import type { RequestContext, SessionTokens } from '../../application/sessions.js';
import type { UserRecord } from '../../application/ports.js';

/** Converts a {@link UserRecord} to the public `User` contract (no credentials, ISO dates). */
export function presentUser(user: UserRecord): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

/** The JSON body of login/refresh responses. The refresh token goes in the cookie only. */
export function presentTokens(tokens: SessionTokens): TokenResponse {
  return {
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    user: presentUser(tokens.user),
  };
}

/** Request facts copied into audit entries. */
export function requestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent, requestId: request.id };
}
