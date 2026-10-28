/**
 * Telemetry preload (ADR-0080). Run as `node --import ./dist/instrument.js dist/main.js`.
 *
 * Why a preload? Auto-instrumentation works by patching libraries (pg, ioredis, http) as
 * they are loaded. Our bundle imports them with static `import`s, which are all evaluated
 * before the first line of `main.ts` runs, so `startTelemetry()` inside `main()` would be
 * too late to patch them. `--import` runs this file first.
 *
 * No ESM loader hook is registered: every library we instrument is CommonJS (or a Node
 * built-in), and Node loads a CommonJS package imported from ESM through the CommonJS
 * loader, where OpenTelemetry's `require` hook patches it. We verified this by running the
 * image with and without `module.register('@opentelemetry/instrumentation/hook.mjs')`:
 * pg/ioredis were instrumented either way (journal 2026-10-28). Add the hook only when an
 * instrumented library ships as pure ESM.
 *
 * Metrics and manual spans work without the preload (e.g. `pnpm dev`); only the library
 * auto-instrumentation needs it.
 */
import { loadConfig } from './platform/config.js';
import { createLogger } from './platform/logger.js';
import { startTelemetry } from './platform/telemetry/sdk.js';

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
