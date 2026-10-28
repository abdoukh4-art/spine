import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/platform/config.js';
import { testConfig } from '../../support/config.js';

describe('auth configuration', () => {
  it('defaults to 10 login attempts per minute and a 30 s user cache, no bootstrap admin', () => {
    const config = testConfig();
    expect(config.AUTH_LOGIN_MAX_PER_MINUTE).toBe(10);
    expect(config.AUTH_USER_CACHE_TTL_SECONDS).toBe(30);
    expect(config.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(config.BOOTSTRAP_ADMIN_PASSWORD).toBeUndefined();
  });

  it('caps the user cache at 30 s (ADR-0060)', () => {
    expect(() => testConfig({ AUTH_USER_CACHE_TTL_SECONDS: '31' })).toThrow(ConfigError);
  });

  it('refuses a placeholder bootstrap password in production (ADR-0066)', () => {
    expect(() =>
      testConfig({
        NODE_ENV: 'production',
        AUTH_JWT_SECRET: 'a-real-random-secret-0123456789abcdefghij',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@corp.test',
        BOOTSTRAP_ADMIN_PASSWORD: 'dev-only-insecure-bootstrap-password-0001',
      }),
    ).toThrow(/BOOTSTRAP_ADMIN_PASSWORD looks like a placeholder/);
  });

  it('rejects a bootstrap password shorter than 12 characters', () => {
    expect(() => testConfig({ BOOTSTRAP_ADMIN_PASSWORD: 'short' })).toThrow(ConfigError);
  });
});
