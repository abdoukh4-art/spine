/**
 * Telemetry preload (ADR-0080). Run as `node --import ./dist/instrument.js dist/main.js`.
 *
 * Why a preload? Auto-instrumentation works by patching libraries (pg, ioredis, http) as
 * they are loaded. Our bundle imports them with static ESM `import`s, which are all
 * evaluated before the first line of `main.ts` runs, so `startTelemetry()` inside `main()`
 * would be too late to patch them. `--import` runs this file first: it registers the
 * ESM loader hook that lets OpenTelemetry wrap ESM imports, then starts the SDK.
 *
 * Metrics and manual spans work without the preload (e.g. `pnpm dev`); only the
 * library auto-instrumentation needs it.
 */
import { register } from 'node:module';
import { loadConfig } from './platform/config.js';
import { createLogger } from './platform/logger.js';
import { startTelemetry } from './platform/telemetry/sdk.js';

// Only these specifiers are wrapped by the ESM hook: wrapping every module costs startup
// time and some packages are incompatible with it. Node built-ins (http) and modules
// `require`d from CommonJS (pg-pool) are patched by the CommonJS hook instead.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
  data: { include: ['pg', 'ioredis'] },
});

const isWorker = /worker\.[cm]?[jt]s$/.test(process.argv[1] ?? '');
try {
  const config = loadConfig({
    ...process.env,
    SERVICE_NAME: process.env.SERVICE_NAME ?? (isWorker ? 'spine-worker' : 'spine-api'),
  });
  startTelemetry(config, createLogger(config));
} catch {
  // Invalid configuration: let the entrypoint report it with a readable message.
}
