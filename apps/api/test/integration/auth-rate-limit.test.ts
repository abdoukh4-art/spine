import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedis } from '../../src/platform/queue/bullmq.js';
import { testRedisUrl } from '../support/db.js';
import { login, PASSWORD, startAuthHarness, type AuthHarness } from './auth-harness.js';

/**
 * Login throttling (ADR-0024, ADR-0063): 10 attempts per minute per client IP AND per
 * normalized username, counted in Redis so the limit holds across API replicas.
 * Random IPs/emails per run keep reruns against a shared Redis independent.
 */
const redis = createRedis(testRedisUrl());
let h: AuthHarness;
const run = randomBytes(3);
const ipBase = `10.${run[0]}.${run[1]}`;

beforeAll(async () => {
  h = await startAuthHarness({ env: { AUTH_LOGIN_MAX_PER_MINUTE: '10' }, redis });
  await h.auth.seedUsers([
    { email: 'target@spine.test', displayName: 'T', role: 'viewer', password: PASSWORD },
  ]);
});
afterAll(async () => {
  await h.close();
  await redis.quit();
});

describe('login rate limits', () => {
  it('blocks the 11th attempt from one IP within a minute (429 + Retry-After)', async () => {
    const ip = `${ipBase}.1`;
    for (let i = 0; i < 10; i++) {
      const { res } = await login(
        h.app,
        `user${i}-${run.toString('hex')}@spine.test`,
        'wrong password!',
        ip,
      );
      expect(res.statusCode).toBe(401);
    }
    const { res } = await login(h.app, `fresh-${run.toString('hex')}@spine.test`, PASSWORD, ip);
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().type).toBe('https://spine.dev/problems/rate-limited');
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(h.metrics.logins.throttled).toBeGreaterThanOrEqual(1);
  });

  it('blocks the 11th attempt on one username even when every attempt uses a new IP', async () => {
    const email = `victim-${run.toString('hex')}@spine.test`;
    for (let i = 0; i < 10; i++) {
      const { res } = await login(h.app, email, 'wrong password!', `${ipBase}.${100 + i}`);
      expect(res.statusCode).toBe(401);
    }
    // Different case and a new IP: still the same normalized username bucket.
    const { res } = await login(h.app, email.toUpperCase(), PASSWORD, `${ipBase}.200`);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('throttles before checking the password, so even the right password is refused', async () => {
    const ip = `${ipBase}.2`;
    for (let i = 0; i < 10; i++) await login(h.app, `x${i}@spine.test`, 'nope nope nope', ip);
    const { res } = await login(h.app, 'target@spine.test', PASSWORD, ip);
    expect(res.statusCode).toBe(429);
    // From another IP, the real user is unaffected.
    expect((await login(h.app, 'target@spine.test', PASSWORD, `${ipBase}.3`)).res.statusCode).toBe(
      200,
    );
  });

  it('keeps counters in Redis without storing the raw email', async () => {
    const keys = await redis.keys('spine:login-attempts:*');
    expect(keys.some((k) => k.includes(`ip:${ipBase}.1`))).toBe(true);
    expect(keys.some((k) => k.includes('@'))).toBe(false);
    const ttl = await redis.pttl(keys.find((k) => k.includes(`ip:${ipBase}.1`))!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});
