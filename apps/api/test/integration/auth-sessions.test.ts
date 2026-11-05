import { createHash } from 'node:crypto';
import { SignJWT, UnsecuredJWT, decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API,
  bearer,
  cookieCall,
  login,
  ORIGIN,
  PASSWORD,
  startAuthHarness,
  type AuthHarness,
} from './auth-harness.js';

/**
 * Login, access tokens, refresh rotation, reuse detection, the concurrent-refresh race,
 * CSRF and logout, against a real Postgres (ADR-0016, ADR-0060..0062).
 */
let h: AuthHarness;
const SECRET = 'test-secret-that-is-at-least-32-characters-long';

beforeAll(async () => {
  h = await startAuthHarness();
  await h.auth.seedUsers([
    { email: 'analyst@spine.test', displayName: 'Ana', role: 'analyst', password: PASSWORD },
    { email: 'viewer@spine.test', displayName: 'Vic', role: 'viewer', password: PASSWORD },
    { email: 'admin@spine.test', displayName: 'Ada', role: 'admin', password: PASSWORD },
    { email: 'racer@spine.test', displayName: 'Ray', role: 'viewer', password: PASSWORD },
  ]);
});
afterAll(() => h.close());

const sha256 = (raw: string) => createHash('sha256').update(raw, 'utf8').digest();

function tokenRow(raw: string) {
  return h.t.db
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('token_hash', '=', sha256(raw))
    .executeTakeFirstOrThrow();
}

function auditRows(action: string) {
  return h.t.db.selectFrom('audit_log').selectAll().where('action', '=', action).execute();
}

describe('POST /auth/login', () => {
  it('returns an access token, the user (no hash) and a hardened refresh cookie', async () => {
    const { res, accessToken, refresh } = await login(h.app, 'Analyst@Spine.TEST');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({ email: 'analyst@spine.test', role: 'analyst' });
    expect(JSON.stringify(body)).not.toMatch(/argon2|passwordHash|password_hash/);
    expect(body.expiresIn).toBe(900);
    expect(res.headers['cache-control']).toBe('no-store');

    const claims = decodeJwt(accessToken);
    expect(claims).toMatchObject({ iss: 'spine', aud: 'spine-api', role: 'analyst' });
    expect(claims.sub).toBe(body.user.id);
    expect(claims.exp! - claims.iat!).toBe(900);
    expect(typeof claims.jti).toBe('string');

    const cookie = res.cookies.find((c) => c.name === 'spine_refresh')!;
    expect(refresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
      path: '/api/v1/auth',
      maxAge: 604_800,
    });
    // testConfig sets COOKIE_SECURE=false; production default is true (config.test.ts).
    expect(cookie.secure).toBeUndefined();
    // Only the SHA-256 is stored, never the raw token.
    const row = await tokenRow(refresh);
    expect(row.token_hash.toString('base64url')).not.toBe(refresh);

    const me = await h.app.inject({ url: `${API}/auth/me`, headers: bearer(accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'analyst@spine.test' });
    expect(me.json().lastLoginAt).not.toBeNull();
  });

  it('answers every failure with the same generic 401 and audits it without the raw email', async () => {
    const unknown = await login(h.app, 'nobody@spine.test');
    const wrong = await login(h.app, 'analyst@spine.test', 'wrong password!!');
    for (const { res } of [unknown, wrong]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().detail).toBe('invalid credentials');
      expect(res.cookies).toHaveLength(0);
    }
    const failed = await auditRows('auth.login_failed');
    const reasons = failed.map((r) => r.details.reason).sort();
    expect(reasons).toEqual(['bad_password', 'unknown_user']);
    expect(JSON.stringify(failed)).not.toContain('nobody@spine.test');
    for (const row of failed) {
      expect(row.details.emailFingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect(row.ip).toBe('127.0.0.1');
    }
    expect(h.metrics.logins.failure).toBeGreaterThanOrEqual(2);
    const ok = await auditRows('auth.login_succeeded');
    expect(ok.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a disabled user with the same generic error', async () => {
    await h.auth.seedUsers([
      { email: 'gone@spine.test', displayName: 'Gone', role: 'viewer', password: PASSWORD },
    ]);
    await h.t.db
      .updateTable('users')
      .set({ disabled: true })
      .where('email', '=', 'gone@spine.test')
      .execute();
    const { res } = await login(h.app, 'gone@spine.test');
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toBe('invalid credentials');
  });
});

describe('access tokens', () => {
  it('rejects alg:none, wrong audience, wrong issuer, bad signature and garbage', async () => {
    const { accessToken, res } = await login(h.app, 'viewer@spine.test');
    const sub = res.json().user.id as string;
    const key = new TextEncoder().encode(SECRET);
    const now = Math.floor(Date.now() / 1000);
    const forge = (iss: string, aud: string, signingKey = key) =>
      new SignJWT({ role: 'admin' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer(iss)
        .setAudience(aud)
        .setJti('x')
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(signingKey);
    const unsecured = new UnsecuredJWT({ role: 'admin' })
      .setSubject(sub)
      .setIssuer('spine')
      .setAudience('spine-api')
      .setJti('x')
      .setExpirationTime(now + 600)
      .encode();
    const bad = [
      unsecured,
      await forge('spine', 'another-api'),
      await forge('someone-else', 'spine-api'),
      await forge('spine', 'spine-api', new TextEncoder().encode('x'.repeat(40))),
      `${accessToken.slice(0, -2)}xx`,
      'not.a.jwt',
    ];
    for (const token of bad) {
      const r = await h.app.inject({ url: `${API}/auth/me`, headers: bearer(token) });
      expect(r.statusCode, token).toBe(401);
    }
    // Sanity check: a correctly forged token (we know the secret) passes.
    const good = await h.app.inject({
      url: `${API}/auth/me`,
      headers: bearer(await forge('spine', 'spine-api')),
    });
    expect(good.statusCode).toBe(200);
    // ...but its role claim is ignored: the DB role (viewer) wins.
    const asAdmin = await h.app.inject({
      url: `${API}/users`,
      headers: bearer(await forge('spine', 'spine-api')),
    });
    expect(asAdmin.statusCode).toBe(403);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates: new cookie and token, old token revoked and linked to its successor', async () => {
    const first = await login(h.app, 'analyst@spine.test');
    const res = await cookieCall(h.app, 'refresh', first.refresh);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('analyst@spine.test');
    const next = res.cookies.find((c) => c.name === 'spine_refresh')!.value;
    expect(next).not.toBe(first.refresh);
    const old = await tokenRow(first.refresh);
    const successor = await tokenRow(next);
    expect(old.revoked_at).not.toBeNull();
    expect(old.replaced_by).toBe(successor.id);
    expect(successor.family_id).toBe(old.family_id);
    expect(successor.revoked_at).toBeNull();
  });

  it('detects reuse of a rotated token, revokes the whole family, audits and counts it', async () => {
    const reuseBefore = h.metrics.reuse;
    const first = await login(h.app, 'analyst@spine.test');
    const rotated = await cookieCall(h.app, 'refresh', first.refresh);
    const current = rotated.cookies.find((c) => c.name === 'spine_refresh')!.value;

    const replay = await cookieCall(h.app, 'refresh', first.refresh);
    expect(replay.statusCode).toBe(401);
    // The cookie is cleared on failure.
    expect(replay.cookies.find((c) => c.name === 'spine_refresh')?.value).toBe('');

    // The legitimate client's newest token died with the family.
    expect((await cookieCall(h.app, 'refresh', current)).statusCode).toBe(401);
    const family = await h.t.db
      .selectFrom('refresh_tokens')
      .select('revoked_at')
      .where('family_id', '=', (await tokenRow(current)).family_id)
      .execute();
    expect(family.every((r) => r.revoked_at !== null)).toBe(true);

    const audit = await auditRows('auth.refresh_token_reuse_detected');
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.target_id).toBe(rotated.json().user.id);
    expect(h.metrics.reuse).toBeGreaterThan(reuseBefore);
  });

  it('lets exactly one of two concurrent refreshes with the same token succeed', async () => {
    for (let round = 0; round < 5; round++) {
      const { refresh } = await login(h.app, 'racer@spine.test');
      const results = await Promise.all([
        cookieCall(h.app, 'refresh', refresh),
        cookieCall(h.app, 'refresh', refresh),
      ]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses, `round ${round}`).toEqual([200, 401]);
      // Only one successor was ever minted for that token.
      const successors = await h.t.db
        .selectFrom('refresh_tokens')
        .select('id')
        .where('family_id', '=', (await tokenRow(refresh)).family_id)
        .execute();
      expect(successors).toHaveLength(2);
    }
  });

  it('rejects missing, malformed and unknown cookies', async () => {
    expect((await cookieCall(h.app, 'refresh', undefined)).statusCode).toBe(401);
    expect((await cookieCall(h.app, 'refresh', 'short')).statusCode).toBe(401);
    expect((await cookieCall(h.app, 'refresh', 'A'.repeat(43))).statusCode).toBe(401);
  });
});

describe('CSRF on cookie endpoints', () => {
  const cases: [string, Record<string, string>][] = [
    ['no CSRF header', { origin: ORIGIN }],
    ['wrong CSRF header value', { 'x-spine-csrf': 'yes', origin: ORIGIN }],
    ['no Origin', { 'x-spine-csrf': '1' }],
    ['foreign Origin', { 'x-spine-csrf': '1', origin: 'https://evil.example' }],
    ['null Origin', { 'x-spine-csrf': '1', origin: 'null' }],
  ];
  for (const path of ['refresh', 'logout'] as const) {
    for (const [name, headers] of cases) {
      it(`rejects /auth/${path} with ${name} (403), leaving the token usable`, async () => {
        const { refresh } = await login(h.app, 'viewer@spine.test');
        const res = await cookieCall(h.app, path, refresh, headers);
        expect(res.statusCode).toBe(403);
        expect(res.json().detail).toBe('CSRF check failed');
        expect((await tokenRow(refresh)).revoked_at).toBeNull();
      });
    }
  }
});

describe('POST /auth/logout', () => {
  it('revokes the family, clears the cookie, and is idempotent', async () => {
    const { refresh } = await login(h.app, 'viewer@spine.test');
    const res = await cookieCall(h.app, 'logout', refresh);
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === 'spine_refresh')!;
    expect(cleared.value).toBe('');
    expect(cleared.path).toBe('/api/v1/auth');
    expect((await tokenRow(refresh)).revoked_at).not.toBeNull();
    expect((await cookieCall(h.app, 'refresh', refresh)).statusCode).toBe(401);
    expect((await cookieCall(h.app, 'logout', refresh)).statusCode).toBe(204);
    expect((await cookieCall(h.app, 'logout', undefined)).statusCode).toBe(204);
    expect((await auditRows('auth.logout')).length).toBeGreaterThanOrEqual(1);
  });
});
