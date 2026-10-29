import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      thresholds: { lines: 85, branches: 80, functions: 85, statements: 85 },
    },
  },
});
