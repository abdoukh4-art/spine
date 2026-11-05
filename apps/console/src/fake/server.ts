import type { Role, TokenResponse } from '@spine/shared-schema';
import { createFakeDb, type FakeDb, type FakeUser } from './fixtures';
import {
  FakeProblem,
  memoryCookieJar,
  problemResponse,
  publicUser,
  requireRole,
  type CookieJar,
} from './http';
export { publicUser } from './http';
import { ROUTES, type FakeRoute } from './routes';

/** Options for {@link FakeSpineServer}. */
export interface FakeServerOptions {
  /** Clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Where the "refresh cookie" lives. Defaults to a fresh in-memory jar. */
  cookieJar?: CookieJar;
  /** Artificial latency per request, to make loading states visible in the demo. */
  latencyMs?: number;
  /** Start from this database instead of fresh fixtures. */
  db?: FakeDb;
  /** Access-token lifetime reported to the client. */
  accessTokenTtlSeconds?: number;
}

/** A forced failure, for tests of error and retry paths. */
interface InjectedFailure {
  method: string;
  path: string;
  status: number;
  slug: string;
  title: string;
}

/** Context passed to every fake route handler. */
export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** The authenticated user (non-null on every non-public route). */
  user: FakeUser | null;
  headers: Headers;
  server: FakeSpineServer;
  now: number;
}

/**
 * An in-browser fake of the Spine API, implementing the documented contract
 * (docs/architecture/api-contract.md) over an in-memory database. It is a `fetch`
 * implementation, injected into the real {@link HttpClient}, so the whole console (auth
 * dance, schema validation, error handling) runs unmodified against it. Used by the tests
 * and by the standalone demo (`VITE_USE_FAKE_API=true`). See ADR-0071.
 */
export class FakeSpineServer {
  readonly db: FakeDb;
  /** Every request received, in order (`METHOD /path?query`). Tests assert on it. */
  readonly requests: string[] = [];
  readonly cookieJar: CookieJar;
  private readonly clock: () => number;
  private readonly latencyMs: number;
  private readonly ttl: number;
  private readonly tokens = new Map<string, string>();
  private tokenSeq = 0;
  private failures: InjectedFailure[] = [];
  private requestSeq = 0;

  /** Creates a server with fresh fixtures (or the given database). */
  constructor(options: FakeServerOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.db = options.db ?? createFakeDb(this.clock());
    this.cookieJar = options.cookieJar ?? memoryCookieJar();
    this.latencyMs = options.latencyMs ?? 0;
    this.ttl = options.accessTokenTtlSeconds ?? 900;
  }

  /** Current fake time (epoch ms). */
  now(): number {
    return this.clock();
  }

  /** Simulates an existing refresh cookie for this user, so the app starts logged in. */
  signInAs(email: string): FakeUser {
    const user = this.findUserByEmail(email);
    if (!user) throw new Error(`no fake user ${email}`);
    this.cookieJar.set(user.id);
    return user;
  }

  /** Invalidates every issued access token (the next API call gets a 401). */
  expireAccessTokens(): void {
    this.tokens.clear();
  }

  /** Makes the next matching request fail with the given status and problem slug. */
  failNext(
    method: string,
    path: string,
    status: number,
    slug = 'internal',
    title = 'Injected failure',
  ): void {
    this.failures.push({ method, path, status, slug, title });
  }

  /** Number of received requests matching `METHOD /path` (query ignored). */
  count(methodAndPath: string): number {
    return this.requests.filter((r) => r.split('?')[0] === methodAndPath).length;
  }

  /** Looks up a user by email (case-insensitive). */
  findUserByEmail(email: string): FakeUser | undefined {
    return this.db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  }

  /** Issues an access token and the token response the real API returns. */
  issueTokens(user: FakeUser): TokenResponse {
    this.tokenSeq += 1;
    const token = `fake-access-${String(this.tokenSeq)}-${user.id}`;
    this.tokens.set(token, user.id);
    this.cookieJar.set(user.id);
    return { accessToken: token, expiresIn: this.ttl, user: publicUser(user) };
  }

  /** The `fetch` implementation to inject into the HTTP client. */
  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = new URL(input, 'http://spine.fake');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    this.requests.push(`${method} ${path}${url.search}`);
    this.requestSeq += 1;
    const requestId = `fake-req-${String(this.requestSeq)}`;
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    try {
      return await this.dispatch(method, path, url.searchParams, init);
    } catch (error) {
      if (error instanceof FakeProblem) return problemResponse(error, requestId);
      throw error;
    }
  };

  private async dispatch(
    method: string,
    path: string,
    query: URLSearchParams,
    init: RequestInit,
  ): Promise<Response> {
    const failure = this.failures.findIndex((f) => f.method === method && f.path === path);
    if (failure >= 0) {
      const [f] = this.failures.splice(failure, 1);
      if (f) throw new FakeProblem(f.status, f.slug, f.title);
    }
    const match = matchRoute(method, path);
    if (!match)
      throw new FakeProblem(404, 'not-found', 'Not found', `No route for ${method} ${path}`);
    const headers = new Headers(init.headers);
    const user = this.authenticate(headers, match.route.access);
    // Deny by default: every non-public route declares its minimum role (ADR-0017).
    if (match.route.access !== 'public') requireRole(user, match.route.access);
    const body =
      typeof init.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    const response = await match.route.handler({
      params: match.params,
      query,
      body,
      user,
      headers,
      server: this,
      now: this.clock(),
    });
    if (method !== 'GET' && response.ok && match.route.access !== 'public') {
      this.audit(
        user,
        `${method} /api/v1${match.route.pattern}`,
        match.params.id ?? null,
        response.status,
      );
    }
    return response;
  }

  private authenticate(headers: Headers, access: Role | 'public'): FakeUser | null {
    if (access === 'public') return null;
    const header = headers.get('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const userId = this.tokens.get(token);
    const user = this.db.users.find((u) => u.id === userId && !u.disabled);
    if (!user)
      throw new FakeProblem(
        401,
        'unauthenticated',
        'Authentication required',
        'Missing, invalid or expired token.',
      );
    return user;
  }

  private audit(
    user: FakeUser | null,
    action: string,
    targetId: string | null,
    status: number,
  ): void {
    this.db.audit.unshift({
      id: `fake-audit-${String(this.requestSeq)}`,
      occurredAt: new Date(this.clock()).toISOString(),
      actorId: user?.id ?? null,
      actorType: user ? 'user' : 'anonymous',
      action,
      targetType: action.split('/')[3] ?? null,
      targetId,
      outcomeStatus: status,
      requestId: `fake-req-${String(this.requestSeq)}`,
      ip: '127.0.0.1',
      userAgent: 'fake',
      details: {},
    });
  }
}

function matchRoute(
  method: string,
  path: string,
): { route: FakeRoute; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const names: string[] = [];
    const regex = new RegExp(
      `^${route.pattern.replace(/:([a-zA-Z]+)/g, (_m, name: string) => {
        names.push(name);
        return '([^/]+)';
      })}$`,
    );
    const found = regex.exec(path);
    if (!found) continue;
    const params: Record<string, string> = {};
    names.forEach((name, i) => {
      params[name] = decodeURIComponent(found[i + 1] ?? '');
    });
    return { route, params };
  }
  return null;
}
