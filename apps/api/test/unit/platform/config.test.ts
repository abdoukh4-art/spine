import { describe, expect, it } from 'vitest';
import { ConfigError, apiDocsEnabled, loadConfig } from '../../../src/platform/config.js';
import { decodeCursor, encodeCursor, paginate } from '../../../src/platform/http/pagination.js';
import { ValidationError } from '../../../src/platform/errors.js';
import { testConfig } from '../../support/config.js';

describe('loadConfig', () => {
  it('applies defaults and parses lists and booleans', () => {
    const c = testConfig({
      CORS_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
      TRUST_PROXY: '1',
    });
    expect(c.HTTP_PORT).toBe(3000);
    expect(c.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(c.TRUST_PROXY).toBe(true);
    expect(c.WEBHOOK_SOURCES_JSON).toEqual({});
  });

  it('lists every problem at once', () => {
    try {
      loadConfig({ AUTH_JWT_SECRET: 'short' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('REDIS_URL');
      expect(msg).toContain('AUTH_JWT_SECRET');
    }
  });

  it('rejects placeholder secrets in production', () => {
    expect(() =>
      testConfig({
        NODE_ENV: 'production',
        AUTH_JWT_SECRET: 'change-me-change-me-change-me-change-me',
      }),
    ).toThrow(/placeholder/);
  });

  it('validates webhook sources', () => {
    const ok = testConfig({
      WEBHOOK_SOURCES_JSON: JSON.stringify({
        suricata: { normalizer: 'suricata-eve', secret: 'x'.repeat(32) },
      }),
    });
    expect(ok.WEBHOOK_SOURCES_JSON.suricata?.normalizer).toBe('suricata-eve');
    expect(() => testConfig({ WEBHOOK_SOURCES_JSON: '{"bad source":{}}' })).toThrow(ConfigError);
    expect(() => testConfig({ WEBHOOK_SOURCES_JSON: 'not json' })).toThrow(ConfigError);
  });

  it('enables API docs outside production by default', () => {
    expect(apiDocsEnabled(testConfig())).toBe(true);
    expect(
      apiDocsEnabled(
        testConfig({
          NODE_ENV: 'production',
          AUTH_JWT_SECRET: 'a'.repeat(40),
          COOKIE_SECURE: 'true',
        }),
      ),
    ).toBe(false);
    expect(apiDocsEnabled(testConfig({ ENABLE_API_DOCS: 'false' }))).toBe(false);
  });
});

describe('production safety rails (security review F1)', () => {
  const prod = { NODE_ENV: 'production', AUTH_JWT_SECRET: 'r'.repeat(48), COOKIE_SECURE: 'true' };
  it('refuses the public placeholder webhook secrets from .env.example', () => {
    expect(() =>
      testConfig({
        ...prod,
        WEBHOOK_SOURCES_JSON: JSON.stringify({
          edr: {
            normalizer: 'canonical',
            secret: 'dev-only-insecure-webhook-secret-edr-000000001',
          },
        }),
      }),
    ).toThrow(/placeholder secret for source\(s\) edr/);
  });
  it('refuses insecure refresh cookies', () => {
    expect(() => testConfig({ ...prod, COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE must be true/,
    );
  });
  it('accepts a production config with real secrets', () => {
    const c = testConfig({
      ...prod,
      WEBHOOK_SOURCES_JSON: JSON.stringify({
        edr: { normalizer: 'canonical', secret: 'k'.repeat(48) },
      }),
    });
    expect(c.WEBHOOK_SOURCES_JSON.edr?.normalizer).toBe('canonical');
  });
});

describe('cursor pagination', () => {
  it('round-trips cursors', () => {
    const c = { k: '2026-10-28T10:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ k: null, id: 'x' }))).toEqual({ k: null, id: 'x' });
  });
  it('rejects malformed cursors with a validation error', () => {
    expect(() => decodeCursor('!!!')).toThrow(ValidationError);
    expect(() => decodeCursor(Buffer.from('{"k":{}}').toString('base64url'))).toThrow(
      ValidationError,
    );
  });
  it('detects the next page from limit + 1 rows', () => {
    const rows = [1, 2, 3].map((n) => ({ n, id: String(n) }));
    const page = paginate(rows, 2, (r) => ({ k: r.n, id: r.id }));
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor!)).toEqual({ k: 2, id: '2' });
    expect(paginate(rows, 3, (r) => ({ k: r.n, id: r.id })).nextCursor).toBeNull();
  });
});
