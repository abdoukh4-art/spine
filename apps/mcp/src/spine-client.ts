import { TokenResponseSchema } from '@spine/shared-schema';
import type { z } from 'zod';

/** A failed call to Spine, carrying the RFC 9457 problem when the API sent one. */
export class SpineApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problemType?: string,
  ) {
    super(message);
    this.name = 'SpineApiError';
  }
}

/** Options for {@link SpineClient}. */
export interface SpineClientOptions {
  baseUrl: string;
  email: string;
  password: string;
  timeoutMs: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

/**
 * Minimal client for Spine's public HTTP API, used by the MCP server (ADR-0096).
 *
 * - Authenticates as the AI analyst's own account and re-logs in once on `401` (access tokens
 *   expire after 15 minutes; this client never holds a refresh cookie).
 * - Validates every response against the shared Zod contracts, so a model never sees data that
 *   doesn't match the documented API.
 * - Sends a recognizable `User-Agent`, which the audit log records next to each action.
 */
export class SpineClient {
  private token: string | null = null;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: SpineClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  /** `GET path?query`, validated with `schema`. */
  get<T>(path: string, schema: z.ZodType<T>, query: Query = {}): Promise<T> {
    return this.request('GET', `${path}${toSearch(query)}`, schema);
  }

  /** `POST path` with a JSON body, validated with `schema`. */
  post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.request('POST', path, schema, body);
  }

  /** `PATCH path` with a JSON body, validated with `schema`. */
  patch<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.request('PATCH', path, schema, body);
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    this.token ??= await this.login();
    let res = await this.send(method, path, body, this.token);
    if (res.status === 401) {
      // The access token expired: log in again once, then give up.
      this.token = await this.login();
      res = await this.send(method, path, body, this.token);
    }
    if (!res.ok) throw await toError(res);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      throw new SpineApiError(res.status, `unexpected response shape from ${method} ${path}`);
    }
    return parsed.data;
  }

  private async login(): Promise<string> {
    const res = await this.send('POST', '/api/v1/auth/login', {
      email: this.options.email,
      password: this.options.password,
    });
    if (!res.ok) throw await toError(res, 'login failed for the AI analyst account');
    return TokenResponseSchema.parse(await res.json()).accessToken;
  }

  private send(method: string, path: string, body: unknown, token?: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'spine-mcp/0.1 (AI analyst)',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    return this.fetchFn(`${this.options.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
  }
}

function toSearch(query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value as readonly string[]) params.append(key, v);
    else params.append(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function toError(res: Response, prefix?: string): Promise<SpineApiError> {
  let detail = res.statusText;
  let type: string | undefined;
  try {
    const problem = (await res.json()) as { title?: string; detail?: string; type?: string };
    detail = problem.detail ?? problem.title ?? detail;
    type = problem.type;
  } catch {
    // Not a problem document (e.g. an HTML error page from a proxy).
  }
  const message = `${prefix ? `${prefix}: ` : ''}Spine answered ${res.status}: ${detail}`;
  return new SpineApiError(res.status, message, type);
}
