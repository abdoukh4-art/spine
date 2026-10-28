import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/modules/auth/application/bootstrap.js';
import { Argon2PasswordHasher } from '../../src/modules/auth/adapters/argon2-hasher.js';
import { PostgresUserRepository } from '../../src/modules/auth/adapters/postgres-users.js';
import { uuidV7Generator } from '../../src/platform/runtime.js';
import { createTestDatabase } from '../support/db.js';
import {
  API,
  bearer,
  login,
  PASSWORD,
  startAuthHarness,
  type AuthHarness,
} from './auth-harness.js';

/**
 * Admin user management, last-admin protection, RBAC 401/403, the audit hook and the
 * audit-log API, plus first-run bootstrap (ADR-0017, ADR-0064..0066).
 */
let h: AuthHarness;
let adminToken: string;
let adminId: string;
let viewerToken: string;
let analystToken: string;

beforeAll(async () => {
  h = await startAuthHarness();
  await h.auth.seedUsers([
    { email: 'root@spine.test', displayName: 'Root', role: 'admin', password: PASSWORD },
    { email: 'viewer@spine.test', displayName: 'Vic', role: 'viewer', password: PASSWORD },
    { email: 'analyst@spine.test', displayName: 'Ana', role: 'analyst', password: PASSWORD },
  ]);
  const admin = await login(h.app, 'root@spine.test');
  adminToken = admin.accessToken;
  adminId = admin.res.json().user.id;
  viewerToken = (await login(h.app, 'viewer@spine.test')).accessToken;
  analystToken = (await login(h.app, 'analyst@spine.test')).accessToken;
});
afterAll(() => h.close());

function createUser(token: string, body: Record<string, unknown>, ua = 'vitest-agent/1.0') {
  return h.app.inject({
    method: 'POST',
    url: `${API}/users`,
    headers: { ...bearer(token), 'user-agent': ua },
    payload: body,
  });
}

function patchUser(token: string, id: string, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'PATCH',
    url: `${API}/users/${id}`,
    headers: bearer(token),
    payload: body,
  });
}

const newUser = (email: string, role = 'viewer') => ({
  email,
  displayName: email.split('@')[0],
  role,
  password: PASSWORD,
});

describe('RBAC on admin routes', () => {
  const routes = [
    { method: 'GET' as const, url: `${API}/users` },
    { method: 'POST' as const, url: `${API}/users` },
    { method: 'PATCH' as const, url: `${API}/users/0190a0a0-0000-7000-8000-000000000001` },
    { method: 'GET' as const, url: `${API}/audit-log` },
  ];

  it('returns 401 without a token and 403 for viewer and analyst', async () => {
    for (const route of routes) {
      expect((await h.app.inject(route)).statusCode, route.url).toBe(401);
      for (const token of [viewerToken, analystToken]) {
        const res = await h.app.inject({ ...route, headers: bearer(token), payload: {} });
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
      }
    }
  });

  it('lets a viewer read /auth/me', async () => {
    const res = await h.app.inject({ url: `${API}/auth/me`, headers: bearer(viewerToken) });
    expect(res.statusCode).toBe(200);
  });
});

describe('user management', () => {
  it('creates a user, never returning the password hash', async () => {
    const res = await createUser(adminToken, newUser('new.analyst@spine.test', 'analyst'));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      email: 'new.analyst@spine.test',
      role: 'analyst',
      disabled: false,
      lastLoginAt: null,
    });
    expect(Object.keys(res.json()).sort()).toEqual(
      ['createdAt', 'disabled', 'displayName', 'email', 'id', 'lastLoginAt', 'role'].sort(),
    );
    expect((await login(h.app, 'new.analyst@spine.test')).res.statusCode).toBe(200);
  });

  it('returns 409 for a duplicate email, case-insensitively', async () => {
    await createUser(adminToken, newUser('dup@spine.test'));
    const res = await createUser(adminToken, newUser('DUP@spine.test'));
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 for a password that fails the policy', async () => {
    const weak = await createUser(adminToken, { ...newUser('weak@spine.test'), password: 'short' });
    expect(weak.statusCode).toBe(400);
    const personal = await createUser(adminToken, {
      ...newUser('mallory@spine.test'),
      password: 'mallory-is-my-name',
    });
    expect(personal.statusCode).toBe(400);
    expect(personal.json().errors[0].path).toBe('body.password');
  });

  it('lists users by email with keyset pagination and no duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const res = await h.app.inject({ url: `${API}/users${query}`, headers: bearer(adminToken) });
      expect(res.statusCode).toBe(200);
      const page = res.json<{ items: { email: string }[]; nextCursor: string | null }>();
      seen.push(...page.items.map((u) => u.email));
      expect(JSON.stringify(page)).not.toContain('argon2');
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain('root@spine.test');
  });

  it('applies role changes immediately (DB role wins over the token claim)', async () => {
    const created = await createUser(adminToken, newUser('promote.me@spine.test'));
    const { accessToken } = await login(h.app, 'promote.me@spine.test');
    const before = await h.app.inject({ url: `${API}/users`, headers: bearer(accessToken) });
    expect(before.statusCode).toBe(403);
    const patched = await patchUser(adminToken, created.json().id, { role: 'admin' });
    expect(patched.json().role).toBe('admin');
    const after = await h.app.inject({ url: `${API}/users`, headers: bearer(accessToken) });
    expect(after.statusCode).toBe(200);
  });

  it('disabling a user rejects their access token and revokes their refresh tokens', async () => {
    const created = await createUser(adminToken, newUser('leaver@spine.test'));
    const { accessToken, refresh } = await login(h.app, 'leaver@spine.test');
    expect(
      (await h.app.inject({ url: `${API}/auth/me`, headers: bearer(accessToken) })).statusCode,
    ).toBe(200);
    expect((await patchUser(adminToken, created.json().id, { disabled: true })).statusCode).toBe(
      200,
    );
    const me = await h.app.inject({ url: `${API}/auth/me`, headers: bearer(accessToken) });
    expect(me.statusCode).toBe(401);
    const live = await h.t.db
      .selectFrom('refresh_tokens')
      .select('id')
      .where('user_id', '=', created.json().id)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toHaveLength(0);
    expect(refresh).not.toBe('');
  });

  it('returns 404 for an unknown user id', async () => {
    const res = await patchUser(adminToken, '0190a0a0-0000-7000-8000-00000000dead', {
      displayName: 'x',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('last-admin protection', () => {
  it('refuses to demote or disable the last active admin (409), even themself', async () => {
    // Earlier tests promoted promote.me@spine.test; disable that admin so root is the last one.
    const promoted = await h.t.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', 'promote.me@spine.test')
      .executeTakeFirstOrThrow();
    expect((await patchUser(adminToken, promoted.id, { disabled: true })).statusCode).toBe(200);

    const demote = await patchUser(adminToken, adminId, { role: 'analyst' });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().detail).toBe('this change would leave no active admin');
    const disable = await patchUser(adminToken, adminId, { disabled: true });
    expect(disable.statusCode).toBe(409);
    // Harmless edits of the last admin are fine.
    expect((await patchUser(adminToken, adminId, { displayName: 'Root 2' })).statusCode).toBe(200);
  });

  it('serializes two admins demoting each other: exactly one succeeds', async () => {
    const other = await createUser(adminToken, newUser('second.admin@spine.test', 'admin'));
    const otherToken = (await login(h.app, 'second.admin@spine.test')).accessToken;
    const results = await Promise.all([
      patchUser(adminToken, other.json().id, { role: 'viewer' }),
      patchUser(otherToken, adminId, { role: 'viewer' }),
    ]);
    const statuses = results.map((r) => r.statusCode).sort();
    // Either one demotion wins (200) and the loser's request is refused: 409 because it
    // would remove the last admin, or 403 when the loser was demoted before its own
    // request was authorized.
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    const active = await h.t.db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'admin')
      .where('disabled', '=', false)
      .execute();
    expect(active).toHaveLength(1);
    // Restore root as admin for the following tests, using whichever admin survived.
    if (active[0]!.id !== adminId) {
      expect((await patchUser(otherToken, adminId, { role: 'admin' })).statusCode).toBe(200);
    }
  });
});

describe('audit trail', () => {
  it('records every mutating request with actor, route, target, status, request id, ip and UA', async () => {
    const created = await createUser(adminToken, newUser('audited@spine.test'), 'audit-ua/2.0');
    const id = created.json().id as string;
    await patchUser(adminToken, id, { displayName: 'Audited' });
    await createUser(viewerToken, newUser('nope@spine.test'));

    await expect
      .poll(async () =>
        h.t.db
          .selectFrom('audit_log')
          .selectAll()
          .where('request_id', 'in', [created.headers['x-request-id'] as string])
          .execute(),
      )
      .toHaveLength(1);
    const rows = await h.t.db.selectFrom('audit_log').selectAll().orderBy('id').execute();
    const create = rows.find((r) => r.request_id === created.headers['x-request-id'])!;
    expect(create).toMatchObject({
      actor_id: adminId,
      actor_type: 'user',
      action: 'POST /api/v1/users',
      outcome_status: 201,
      ip: '127.0.0.1',
      user_agent: 'audit-ua/2.0',
      details: {},
    });
    await expect
      .poll(async () =>
        (await h.t.db.selectFrom('audit_log').selectAll().execute()).filter(
          (r) => r.action === 'PATCH /api/v1/users/:id' && r.target_id === id,
        ),
      )
      .toHaveLength(1);
    const patch = (await h.t.db.selectFrom('audit_log').selectAll().execute()).find(
      (r) => r.action === 'PATCH /api/v1/users/:id' && r.target_id === id,
    )!;
    expect(patch.target_type).toBe('users');
    // A forbidden attempt is recorded too, attributed to the (authenticated) viewer.
    await expect
      .poll(async () =>
        (await h.t.db.selectFrom('audit_log').selectAll().execute())
          .filter((r) => r.action === 'POST /api/v1/users' && r.outcome_status === 403)
          .map((r) => r.actor_type),
      )
      .toContain('user');
  });

  it('never stores request bodies or secrets', async () => {
    const all = JSON.stringify(await h.t.db.selectFrom('audit_log').selectAll().execute());
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('argon2');
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWTs
  });

  it('records login as the user on success and anonymously on failure', async () => {
    const ok = await login(h.app, 'viewer@spine.test');
    const failed = await login(h.app, 'viewer@spine.test', 'definitely wrong');
    await expect
      .poll(async () =>
        h.t.db
          .selectFrom('audit_log')
          .select(['actor_type', 'outcome_status'])
          .where('action', '=', 'POST /api/v1/auth/login')
          .where('request_id', 'in', [
            ok.res.headers['x-request-id'] as string,
            failed.res.headers['x-request-id'] as string,
          ])
          .orderBy('id')
          .execute(),
      )
      .toEqual([
        { actor_type: 'user', outcome_status: 200 },
        { actor_type: 'anonymous', outcome_status: 401 },
      ]);
  });

  it('serves GET /audit-log newest first with prefix filters and keyset pagination', async () => {
    const res = await h.app.inject({
      url: `${API}/audit-log?action=auth.&limit=3`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json<{ items: { id: string; action: string }[]; nextCursor: string }>();
    expect(page.items).toHaveLength(3);
    expect(page.items.every((e) => e.action.startsWith('auth.'))).toBe(true);
    const ids = page.items.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const next = await h.app.inject({
      url: `${API}/audit-log?action=auth.&limit=3&cursor=${page.nextCursor}`,
      headers: bearer(adminToken),
    });
    const nextIds = next.json<{ items: { id: string }[] }>().items.map((e) => Number(e.id));
    expect(Math.max(...nextIds)).toBeLessThan(Math.min(...ids));

    const byActor = await h.app.inject({
      url: `${API}/audit-log?actorId=${adminId}&action=PATCH%20`,
      headers: bearer(adminToken),
    });
    const actorItems = byActor.json<{ items: { actorId: string; action: string }[] }>().items;
    expect(actorItems.length).toBeGreaterThan(0);
    expect(actorItems.every((e) => e.actorId === adminId && e.action.startsWith('PATCH '))).toBe(
      true,
    );

    const literal = await h.app.inject({
      url: `${API}/audit-log?action=${encodeURIComponent('%')}`,
      headers: bearer(adminToken),
    });
    expect(literal.json().items).toEqual([]); // `%` is matched literally, not as a wildcard

    const future = await h.app.inject({
      url: `${API}/audit-log?from=2999-01-01T00:00:00.000Z`,
      headers: bearer(adminToken),
    });
    expect(future.json()).toEqual({ items: [], nextCursor: null });
    const badCursor = await h.app.inject({
      url: `${API}/audit-log?cursor=bm9wZQ`,
      headers: bearer(adminToken),
    });
    expect(badCursor.statusCode).toBe(400);
  });

  it('exposes AuditRecorder for explicit entries, optionally inside a transaction', async () => {
    await h.auth.api.audit.record({
      actorId: adminId,
      actorType: 'user',
      action: 'test.explicit_entry',
      targetType: 'thing',
      targetId: '42',
      details: { why: 'test' },
    });
    await h.t.db
      .transaction()
      .execute(async (trx) => {
        await h.auth.api.audit.record(
          { actorId: null, actorType: 'system', action: 'test.rolled_back' },
          trx,
        );
        throw new Error('rollback');
      })
      .catch(() => undefined);
    const rows = await h.t.db
      .selectFrom('audit_log')
      .select(['action', 'details'])
      .where('action', 'like', 'test.%')
      .execute();
    expect(rows).toEqual([{ action: 'test.explicit_entry', details: { why: 'test' } }]);
  });
});

describe('first-run bootstrap', () => {
  it('creates the admin only when no users exist, once, even when racing', async () => {
    const empty = await createTestDatabase();
    try {
      const deps = {
        users: new PostgresUserRepository(empty.db),
        hasher: new Argon2PasswordHasher(),
        ids: uuidV7Generator,
        logger: pino({ level: 'silent' }),
      };
      expect(await bootstrapAdmin(deps, undefined, undefined)).toBe('skipped');
      const results = await Promise.all([
        bootstrapAdmin(deps, 'First@Spine.test', PASSWORD),
        bootstrapAdmin(deps, 'first@spine.test', PASSWORD),
        bootstrapAdmin(deps, 'other@spine.test', PASSWORD),
      ]);
      expect(results.filter((r) => r === 'created')).toHaveLength(1);
      const users = await empty.db.selectFrom('users').select(['role']).execute();
      expect(users).toEqual([{ role: 'admin' }]);
      expect(await bootstrapAdmin(deps, 'later@spine.test', PASSWORD)).toBe('skipped');
    } finally {
      await empty.destroy();
    }
  });

  it('runs through SpineModule.startup with the configured env', async () => {
    const boot = await startAuthHarness({
      env: { BOOTSTRAP_ADMIN_EMAIL: 'boot@spine.test', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
    });
    try {
      await boot.auth.module.startup?.();
      await boot.auth.module.startup?.();
      const { res } = await login(boot.app, 'boot@spine.test');
      expect(res.statusCode).toBe(200);
      expect(res.json().user.role).toBe('admin');
    } finally {
      await boot.close();
    }
  });
});
