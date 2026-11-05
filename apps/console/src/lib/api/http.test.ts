import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, ContractError, describeError, NetworkError, problemSlug } from './errors';
import { HttpClient, type FetchLike } from './http';

const USER = {
  id: '0192f0a0-0001-7000-8000-000000000002',
  email: 'sam@spine.local',
  displayName: 'Sam Analyst',
  role: 'analyst',
  disabled: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastLoginAt: null,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const problem = (status: number, slug: string, extra: Record<string, unknown> = {}) =>
  json(status, { type: `https://spine.dev/problems/${slug}`, title: slug, status, ...extra });
const tokens = (n: number) =>
  json(200, { accessToken: `token-${String(n)}`, expiresIn: 900, user: USER });

const Thing = z.object({ ok: z.literal(true) });

/**
 * A scripted fake fetch: protected routes accept only the *current* token; /auth/refresh
 * issues a new one. Refreshes resolve only when the test releases them, so we can create
 * truly concurrent 401s.
 */
function scriptedBackend(options: { refreshOk?: boolean } = {}) {
  let valid = 'token-1';
  let issued = 1;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let releaseRefresh: () => void = () => undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/refresh')) {
      await refreshGate;
      if (options.refreshOk === false) return problem(401, 'unauthenticated');
      issued += 1;
      valid = `token-${String(issued)}`;
      return tokens(issued);
    }
    if (url.endsWith('/auth/login')) return tokens(1);
    if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    const auth = new Headers(init?.headers).get('Authorization');
    if (auth !== `Bearer ${valid}`) return problem(401, 'unauthenticated');
    return json(200, { ok: true });
  };
  return {
    fetch,
    calls,
    releaseRefresh: () => releaseRefresh(),
    expire: () => {
      valid = 'nobody-has-this';
    },
    refreshCount: () => calls.filter((c) => c.url.endsWith('/auth/refresh')).length,
  };
}

describe('HttpClient', () => {
  it('sends the bearer token, JSON accept header and base URL', async () => {
    const backend = scriptedBackend();
    const client = new HttpClient({ fetch: backend.fetch });
    await client.login('sam@spine.local', 'pw');
    await expect(
      client.request({
        path: '/things',
        query: { a: 'x', b: ['1', '2'], c: undefined },
        schema: Thing,
      }),
    ).resolves.toEqual({ ok: true });
    const last = backend.calls.at(-1)!;
    expect(last.url).toBe('/api/v1/things?a=x&b=1&b=2');
    expect(new Headers(last.init?.headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('login sends credentials: include so the refresh cookie is stored', async () => {
    const backend = scriptedBackend();
    const client = new HttpClient({ fetch: backend.fetch, now: () => 1_000 });
    const session = await client.login('sam@spine.local', 'pw');
    expect(session.expiresAt).toBe(1_000 + 900_000);
    expect(backend.calls[0]?.init?.credentials).toBe('include');
  });

  it('on 401 refreshes once (cookie + CSRF header) and retries the request', async () => {
    const backend = scriptedBackend();
    const client = new HttpClient({ fetch: backend.fetch });
    await client.login('sam@spine.local', 'pw');
    backend.expire();
    backend.releaseRefresh();
    await expect(client.request({ path: '/things', schema: Thing })).resolves.toEqual({ ok: true });
    const refresh = backend.calls.find((c) => c.url.endsWith('/auth/refresh'))!;
    expect(refresh.init?.method).toBe('POST');
    expect(refresh.init?.credentials).toBe('include');
    expect(new Headers(refresh.init?.headers).get('X-Spine-CSRF')).toBe('1');
    expect(client.getSession()?.accessToken).toBe('token-2');
    expect(backend.refreshCount()).toBe(1);
  });

  it('de-duplicates concurrent 401s into a single refresh', async () => {
    const backend = scriptedBackend();
    const client = new HttpClient({ fetch: backend.fetch });
    await client.login('sam@spine.local', 'pw');
    backend.expire();
    const requests = Array.from({ length: 5 }, () =>
      client.request({ path: '/things', schema: Thing }),
    );
    // Let all five hit their 401 before the refresh answers.
    await vi.waitFor(() => expect(backend.refreshCount()).toBe(1));
    backend.releaseRefresh();
    await expect(Promise.all(requests)).resolves.toHaveLength(5);
    expect(backend.refreshCount()).toBe(1);
  });

  it('reuses a token refreshed by another request instead of refreshing again', async () => {
    const backend = scriptedBackend();
    backend.releaseRefresh();
    const client = new HttpClient({ fetch: backend.fetch });
    await client.login('sam@spine.local', 'pw');
    backend.expire();
    await client.request({ path: '/things', schema: Thing }); // refresh #1 → token-2
    // A late 401 for a request sent with token-1 must not trigger refresh #2.
    const late = client.request({ path: '/things', schema: Thing });
    await expect(late).resolves.toEqual({ ok: true });
    expect(backend.refreshCount()).toBe(1);
  });

  it('logs out (clears the session and notifies) when the refresh fails', async () => {
    const backend = scriptedBackend({ refreshOk: false });
    backend.releaseRefresh();
    const client = new HttpClient({ fetch: backend.fetch });
    const listener = vi.fn();
    client.subscribe(listener);
    await client.login('sam@spine.local', 'pw');
    backend.expire();
    const error = await client.request({ path: '/things', schema: Thing }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(client.getSession()).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null);
  });

  it('does not retry more than once if the refreshed token is rejected too', async () => {
    let count = 0;
    const fetch: FetchLike = (url) => {
      count += 1;
      if (url.endsWith('/auth/refresh')) return Promise.resolve(tokens(9));
      return Promise.resolve(problem(401, 'unauthenticated'));
    };
    const client = new HttpClient({ fetch });
    await expect(client.request({ path: '/x', schema: Thing })).rejects.toBeInstanceOf(ApiError);
    expect(count).toBe(3); // request, refresh, one retry
    expect(client.getSession()).toBeNull();
  });

  it('parses RFC 9457 problems into a typed ApiError', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        problem(409, 'conflict', {
          detail: 'already decided',
          instance: 'req-1',
          errors: [{ path: 'a', message: 'b' }],
        }),
      );
    const client = new HttpClient({ fetch });
    const error = (await client
      .request({ path: '/x', schema: Thing })
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({
      status: 409,
      type: 'conflict',
      title: 'conflict',
      detail: 'already decided',
      instance: 'req-1',
    });
    expect(error.errors).toEqual([{ path: 'a', message: 'b' }]);
    expect(describeError(error)).toBe('already decided');
  });

  it('tolerates error bodies that are not problem documents', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      );
    const error = (await new HttpClient({ fetch })
      .request({ path: '/x', schema: Thing, auth: false })
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 502, type: 'unknown', title: 'Bad Gateway' });
  });

  it('throws a ContractError naming the endpoint and path when the response breaks the schema', async () => {
    const fetch: FetchLike = () => Promise.resolve(json(200, { ok: 'yes' }));
    const error = (await new HttpClient({ fetch })
      .request({ path: '/x', schema: Thing, auth: false })
      .catch((e: unknown) => e)) as ContractError;
    expect(error).toBeInstanceOf(ContractError);
    expect(error.endpoint).toBe('GET /x');
    expect(error.issues[0]).toMatch(/^ok:/);
    expect(describeError(error)).toMatch(/does not understand/);
  });

  it('returns undefined for bodiless responses when no schema is expected', async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response(null, { status: 202 }));
    await expect(
      new HttpClient({ fetch }).request({ method: 'POST', path: '/x', schema: null, auth: false }),
    ).resolves.toBeUndefined();
  });

  it('wraps transport failures in a NetworkError', async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = await new HttpClient({ fetch })
      .request({ path: '/x', schema: Thing })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(describeError(error)).toMatch(/could not be reached/);
    expect(describeError(new Error('x'))).toBe('Something went wrong.');
  });

  it('logout clears the session even when the server is unreachable', async () => {
    const backend = scriptedBackend();
    const client = new HttpClient({ fetch: backend.fetch });
    await client.login('sam@spine.local', 'pw');
    const failing = new HttpClient({ fetch: () => Promise.reject(new TypeError('offline')) });
    await failing.logout();
    expect(failing.getSession()).toBeNull();
    await client.logout();
    expect(client.getSession()).toBeNull();
    const logoutCall = backend.calls.find((c) => c.url.endsWith('/auth/logout'))!;
    expect(new Headers(logoutCall.init?.headers).get('X-Spine-CSRF')).toBe('1');
  });

  it('never writes tokens to Web Storage', async () => {
    const backend = scriptedBackend();
    backend.releaseRefresh();
    const client = new HttpClient({ fetch: backend.fetch });
    await client.login('sam@spine.local', 'pw');
    await client.refresh();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('problemSlug', () => {
  it('reduces type URIs to slugs', () => {
    expect(problemSlug('https://spine.dev/problems/not-found')).toBe('not-found');
    expect(problemSlug('https://example.com/errors/teapot')).toBe('teapot');
    expect(problemSlug('')).toBe('unknown');
  });
});
