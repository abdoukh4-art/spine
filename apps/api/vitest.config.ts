import { defineConfig } from 'vitest/config';

/**
 * Two projects (ADR-0021):
 * - unit: pure + in-memory tests, no Docker, runs in seconds.
 * - integration: real Postgres/Redis via Testcontainers or TEST_DATABASE_URL/TEST_REDIS_URL.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/worker.ts', 'src/cli/**'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
    },
  },
});
