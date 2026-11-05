import type { Logger } from './logger.js';

/**
 * Graceful shutdown (twelve-factor IX: disposability).
 *
 * On SIGTERM/SIGINT: run the registered closers **in order** (e.g. stop accepting HTTP
 * requests → drain workers → close queues → close DB/Redis), each awaited. If the whole
 * sequence exceeds `timeoutMs`, exit non-zero so the orchestrator restarts us rather than
 * leaving a half-dead process.
 */
export interface Closer {
  name: string;
  close(): Promise<void>;
}

export function installGracefulShutdown(options: {
  logger: Logger;
  closers: Closer[];
  timeoutMs: number;
  onShutdownStart?: () => void;
  exit?: (code: number) => void;
}): () => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.onShutdownStart?.();
    options.logger.info({ signal }, 'graceful shutdown started');
    const timer = setTimeout(() => {
      options.logger.error({ timeoutMs: options.timeoutMs }, 'graceful shutdown timed out');
      exit(1);
    }, options.timeoutMs);
    timer.unref();
    let code = 0;
    for (const closer of options.closers) {
      try {
        await closer.close();
        options.logger.info({ component: closer.name }, 'closed');
      } catch (err) {
        code = 1;
        options.logger.error({ err, component: closer.name }, 'error during shutdown');
      }
    }
    clearTimeout(timer);
    options.logger.info('graceful shutdown complete');
    exit(code);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  return () => shutdown('manual');
}
