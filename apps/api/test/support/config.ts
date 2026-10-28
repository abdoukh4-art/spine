import { loadConfig, type Config } from '../../src/platform/config.js';

/** A valid configuration for tests; override any variable as needed. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://spine:spine@127.0.0.1:5432/spine',
    REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    COOKIE_SECURE: 'false',
    ...overrides,
  });
}
