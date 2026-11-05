import { PROBLEM_TYPE_BASE, roleSatisfies, type Role, type User } from '@spine/shared-schema';
import type { FakeUser } from './fixtures';

/** Thrown inside a fake route handler to answer with an RFC 9457 problem. */
export class FakeProblem extends Error {
  /** Builds a problem with the given status, slug and title. */
  constructor(
    readonly status: number,
    readonly slug: string,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(title);
  }
}

/** A JSON response. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** An empty response (202/204). */
export function empty(status: number): Response {
  return new Response(null, { status });
}

/** Serializes a {@link FakeProblem} exactly as the real API would (ADR-0024). */
export function problemResponse(problem: FakeProblem, requestId: string): Response {
  return new Response(
    JSON.stringify({
      type: `${PROBLEM_TYPE_BASE}${problem.slug}`,
      title: problem.title,
      status: problem.status,
      ...(problem.detail ? { detail: problem.detail } : {}),
      instance: requestId,
      ...(problem.errors ? { errors: problem.errors } : {}),
    }),
    { status: problem.status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

/** Asserts an authenticated user with at least `role` (401/403 otherwise). */
export function requireRole(user: FakeUser | null, role: Role): FakeUser {
  if (!user) throw new FakeProblem(401, 'unauthenticated', 'Authentication required');
  if (!roleSatisfies(user.role, role)) {
    throw new FakeProblem(403, 'forbidden', 'Forbidden', `This action needs the ${role} role.`);
  }
  return user;
}

/** Opaque cursor pagination over an in-memory list (the cursor is a base64 offset). */
export function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
): { items: T[]; nextCursor: string | null } {
  const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? 50) || 50));
  const cursor = query.get('cursor');
  const offset = cursor ? Number(atob(cursor)) || 0 : 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? btoa(String(offset + limit)) : null;
  return { items: page, nextCursor: next };
}

/** Where the fake server keeps its "HttpOnly refresh cookie" (the logged-in user id). */
export interface CookieJar {
  get(): string | null;
  set(userId: string): void;
  clear(): void;
}

/** In-memory jar for tests: each test gets a fresh one. */
export function memoryCookieJar(initial: string | null = null): CookieJar {
  let value = initial;
  return {
    get: () => value,
    set: (userId) => {
      value = userId;
    },
    clear: () => {
      value = null;
    },
  };
}

/**
 * Jar backed by a real (non-HttpOnly, fake-only) cookie, so the demo survives a reload the
 * way the real HttpOnly cookie does. It holds a *fake user id*, never a token.
 */
export function documentCookieJar(name = 'spine_fake_refresh'): CookieJar {
  return {
    get: () => {
      const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
      return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
    },
    set: (userId) => {
      document.cookie = `${name}=${encodeURIComponent(userId)}; path=/; SameSite=Strict`;
    },
    clear: () => {
      document.cookie = `${name}=; path=/; max-age=0; SameSite=Strict`;
    },
  };
}

/** Strips the password from a fake user. */
export function publicUser(user: FakeUser): User {
  const { password: _password, ...rest } = user;
  return rest;
}
