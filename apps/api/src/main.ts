import { createApplication } from './composition.js';
import { loadConfig } from './platform/config.js';
import { migrate } from './platform/db/migrator.js';
import { installGracefulShutdown } from './platform/lifecycle.js';
import { createLogger } from './platform/logger.js';
import { createRedis } from './platform/queue/bullmq.js';
import { buildHttpServer, runReadinessChecks } from './platform/http/server.js';
import { startTelemetry } from './platform/telemetry/sdk.js';

/** API process entrypoint: HTTP server only. Background work runs in worker.ts. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const telemetry = startTelemetry(config, logger);
  const redis = createRedis(config.REDIS_URL);
  const app = createApplication(config, {
    logger,
    redis,
    traceparent: () => telemetry.traceparent(),
  });

  if (config.MIGRATE_ON_START) {
    const result = await migrate(app.deps.db, config.MIGRATIONS_DIR);
    logger.info({ applied: result.applied }, 'migrations complete');
  }

  let shuttingDown = false;
  const server = await buildHttpServer({
    config,
    modules: app.modules,
    authenticator: app.authenticator,
    redis,
    readiness: async () => {
      const result = await runReadinessChecks(app.readinessChecks);
      return shuttingDown
        ? { status: 'not_ready', checks: { ...result.checks, shutdown: 'fail' } }
        : result;
    },
  });

  installGracefulShutdown({
    logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    onShutdownStart: () => {
      shuttingDown = true;
    },
    closers: [
      { name: 'http', close: () => server.close() },
      { name: 'database', close: () => app.deps.db.destroy() },
      { name: 'redis', close: async () => void (await redis.quit()) },
      { name: 'telemetry', close: () => telemetry.shutdown() },
    ],
  });

  await server.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- logger may not exist yet if config failed
  console.error(err);
  process.exit(1);
});
