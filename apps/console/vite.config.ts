import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development, proxy API calls so the console and API share an origin (no CORS needed).
    proxy: { '/api': 'http://localhost:3000', '/healthz': 'http://localhost:3000' },
  },
  build: { sourcemap: true, target: 'es2022' },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/test-setup.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
