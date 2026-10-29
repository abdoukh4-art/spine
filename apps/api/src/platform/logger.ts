import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Config } from './config.js';
import { traceContextMixin } from './telemetry/propagation.js';

export type { Logger } from 'pino';

/**
 * Paths redacted from every log line (OWASP A09: never log credentials or tokens).
 * Keep in sync with docs/security/threat-model.md.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-spine-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.token',
];

/** Builds pino options shared by the HTTP server logger and standalone loggers. */
export function loggerOptions(
  config: Pick<Config, 'LOG_LEVEL' | 'SERVICE_NAME' | 'NODE_ENV'>,
): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    base: { service: config.SERVICE_NAME, env: config.NODE_ENV },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Log/trace correlation (ADR-0019): traceId + spanId on every line written inside a span.
    mixin: traceContextMixin,
  };
}

/** Structured JSON logger to stdout (twelve-factor XI: logs are event streams). */
export function createLogger(
  config: Pick<Config, 'LOG_LEVEL' | 'SERVICE_NAME' | 'NODE_ENV'>,
): Logger {
  return pino(loggerOptions(config));
}
