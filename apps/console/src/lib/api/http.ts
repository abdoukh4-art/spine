import { ProblemSchema, TokenResponseSchema, type User } from '@spine/shared-schema';
import type { z } from 'zod';
import { ApiError, ContractError, NetworkError } from './errors';

/** The subset of `fetch` the client needs; the fake API implements the same signature. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** An authenticated session. The access token lives only here, in memory (ADR-0016). */
export interface Session {
  accessToken: string;
  user: User;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
}

/** Called whenever the session changes (login, refresh, logout, failed refresh). */
export type SessionListener = (session: Session | null) => void;

/** A query-string value. Arrays become repeated keys (`?status=new&status=triaged`). */
export type QueryValue = string | number | boolean | readonly string[] | null | undefined;

/** Everything needed to make one API call. */
export interface RequestSpec<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path below the base URL, e.g. `/alerts/123`. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Schema the response body must satisfy, or `null` when no body is expected (202/204). */
  schema: z.ZodType<T> | null;
  /** Send the bearer token and run the 401 → refresh → retry dance. Default true. */
  auth?: boolean;
}

/** Constructor options for {@link HttpClient}. */
export interface HttpClientOptions {
  /** Defaults to `/api/v1` (same origin; Vite proxies it in development). */
  baseUrl?: string;
  /** Defaults to the browser's `fetch`. Tests and the demo mode inject a fake. */
  fetch?: FetchLike;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** Header required on cookie-authenticated endpoints (CSRF defence, ADR-0016). */
const CSRF_HEADERS = { 'X-Spine-CSRF': '1' } as const;

/**
 * A typed `fetch` wrapper for the Spine API.
 *
 * Responsibilities, in order: build the URL, attach `Authorization: Bearer`, parse RFC 9457
 * problems into {@link ApiError}, validate every success body with the shared Zod schema
 * (throwing {@link ContractError} on drift), and on a 401 perform **one** refresh and
 * retry the request once. Concurrent 401s share a single in-flight refresh promise, so a
 * burst of expired requests costs exactly one `POST /auth/refresh`. If the refresh fails
 * the session is cleared, which logs the user out.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private session: Session | null = null;
  private refreshInFlight: Promise<Session | null> | null = null;
  private readonly listeners = new Set<SessionListener>();

  /** Creates a client; nothing is fetched until the first call. */
  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api/v1';
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  /** The current session, or null when logged out. */
  getSession(): Session | null {
    return this.session;
  }

  /** Subscribes to session changes. Returns the unsubscribe function. */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Logs in with a password. Throws {@link ApiError} (401) on bad credentials. */
  async login(email: string, password: string): Promise<Session> {
    const response = await this.send('/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const tokens = await this.handle(response, 'POST /auth/login', TokenResponseSchema);
    return this.setSession({
      accessToken: tokens.accessToken,
      user: tokens.user,
      expiresAt: this.now() + tokens.expiresIn * 1000,
    });
  }

  /**
   * Exchanges the HttpOnly refresh cookie for a new access token. Concurrent callers share
   * one in-flight request. Resolves to null (and clears the session) when the server
   * refuses; rejects with {@link NetworkError} when the server is unreachable.
   */
  refresh(): Promise<Session | null> {
    this.refreshInFlight ??= this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /** Revokes the refresh token family server-side (best effort) and clears the session. */
  async logout(): Promise<void> {
    try {
      await this.send('/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: CSRF_HEADERS,
      });
    } catch {
      // Logging out locally must succeed even if the server is unreachable.
    } finally {
      this.setSession(null);
    }
  }

  /** Performs one API call and returns the schema-validated body. */
  async request<T>(spec: RequestSpec<T>): Promise<T> {
    const endpoint = `${spec.method ?? 'GET'} ${spec.path}`;
    const usedToken = spec.auth === false ? null : (this.session?.accessToken ?? null);
    let response = await this.send(this.url(spec), this.init(spec, usedToken));
    if (response.status === 401 && spec.auth !== false) {
      const renewed = await this.recoverFromUnauthorized(usedToken);
      if (renewed) {
        response = await this.send(this.url(spec), this.init(spec, renewed.accessToken));
        // A fresh token rejected again means the account itself is no longer valid.
        if (response.status === 401) this.setSession(null);
      }
    }
    return this.handle(response, endpoint, spec.schema);
  }

  /**
   * After a 401: if another request already refreshed while ours was in flight, reuse
   * that token instead of refreshing again; otherwise join (or start) the single refresh.
   */
  private async recoverFromUnauthorized(usedToken: string | null): Promise<Session | null> {
    const current = this.session;
    if (current && current.accessToken !== usedToken) return current;
    return this.refresh();
  }

  private async performRefresh(): Promise<Session | null> {
    const response = await this.send('/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { ...CSRF_HEADERS, Accept: 'application/json' },
    });
    if (!response.ok) {
      this.setSession(null);
      return null;
    }
    const tokens = await this.handle(response, 'POST /auth/refresh', TokenResponseSchema);
    return this.setSession({
      accessToken: tokens.accessToken,
      user: tokens.user,
      expiresAt: this.now() + tokens.expiresIn * 1000,
    });
  }

  private setSession<S extends Session | null>(session: S): S {
    this.session = session;
    for (const listener of this.listeners) listener(session);
    return session;
  }

  private url(spec: RequestSpec<unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value as readonly string[]) params.append(key, item);
      } else {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    return qs ? `${spec.path}?${qs}` : spec.path;
  }

  private init(spec: RequestSpec<unknown>, token: string | null): RequestInit {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const init: RequestInit = { method: spec.method ?? 'GET', headers };
    if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(spec.body);
    }
    return init;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      throw new NetworkError(cause);
    }
  }

  private async handle<T>(
    response: Response,
    endpoint: string,
    schema: z.ZodType<T> | null,
  ): Promise<T> {
    if (!response.ok) throw await toApiError(response);
    if (schema === null) return undefined as T;
    const body = await readJson(response);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ContractError(
        endpoint,
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      );
    }
    return parsed.data;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Converts a non-2xx response into an ApiError, tolerating bodies that aren't problems. */
async function toApiError(response: Response): Promise<ApiError> {
  const body = await readJson(response);
  const problem = ProblemSchema.safeParse(body);
  if (problem.success) return new ApiError({ ...problem.data, status: response.status });
  return new ApiError({
    type: 'unknown',
    title: response.statusText || `HTTP ${response.status}`,
    status: response.status,
  });
}
