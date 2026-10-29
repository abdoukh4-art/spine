import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests run against a RUNNING stack (ADR-0021): `make up && make demo`, then `pnpm test:e2e`.
 * They exercise the real nginx → console → API → Postgres/Redis → worker path, so they're the
 * slowest and fewest tests in the pyramid: a handful of critical analyst journeys plus axe checks.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.SPINE_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
