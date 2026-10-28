import { z } from 'zod';

/**
 * Twelve-factor configuration (factor III): everything comes from environment variables,
 * validated once at startup. Invalid config fails fast with a readable message instead of
 * failing later at the first request. See .env.example for documentation of each variable.
 */

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

export const WebhookSourceSchema = z.object({
  /** Normalizer used for this source's payloads (`generic` was removed in ADR-0030). */
  normalizer: z.enum(['canonical', 'suricata-eve', 'cef']),
  /** HMAC-SHA256 shared secret (≥ 32 chars). */
  secret: z.string().min(32),
});
export type WebhookSource = z.infer<typeof WebhookSourceSchema>;

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().default('spine-api'),

  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY: bool.default(false),
  CORS_ALLOWED_ORIGINS: csv.default(['http://localhost:5173']),
  RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(600),
  ENABLE_API_DOCS: bool.optional(),

  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  MIGRATE_ON_START: bool.default(true),
  MIGRATIONS_DIR: z.string().default('migrations'),
  REDIS_URL: z.url(),

  AUTH_JWT_SECRET: z.string().min(32, 'AUTH_JWT_SECRET must be at least 32 characters'),
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  AUTH_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .default(7 * 24 * 3600),
  COOKIE_SECURE: bool.default(true),
  /** Login attempts allowed per minute, per client IP AND per username (ADR-0024). */
  AUTH_LOGIN_MAX_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  /** How long the authenticator may reuse a loaded user (ADR-0060). 0 disables caching. */
  AUTH_USER_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(30).default(30),
  /** First-run admin, created only when the users table is empty (ADR-0066). */
  BOOTSTRAP_ADMIN_EMAIL: z.email().max(254).optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).max(128).optional(),

  INGEST_MAX_BACKLOG: z.coerce.number().int().min(1).default(10_000),
  WEBHOOK_SOURCES_JSON: z
    .string()
    .default('{}')
    .transform((s, ctx) => {
      try {
        return z
          .record(z.string().regex(/^[a-z0-9-]{1,64}$/), WebhookSourceSchema)
          .parse(JSON.parse(s));
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: `invalid WEBHOOK_SOURCES_JSON: ${String(e)}` });
        return z.NEVER;
      }
    }),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(200),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  EVENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(8),
  PLAYBOOK_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  PLAYBOOK_APPROVAL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),

  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

  CONFIG_DIR: z.string().default('config'),
  SIMULATION_LATENCY_MS: z.coerce.number().int().min(0).default(50),
  SIMULATION_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Thrown when environment configuration is invalid. Message lists every problem. */
export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates configuration from an environment map.
 * @param env defaults to `process.env`; tests pass an explicit object.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const config = result.data;
  if (
    config.NODE_ENV === 'production' &&
    /change-me|example|insecure/i.test(config.AUTH_JWT_SECRET)
  ) {
    throw new ConfigError([
      'AUTH_JWT_SECRET looks like a placeholder; set a random secret in production',
    ]);
  }
  if (
    config.NODE_ENV === 'production' &&
    config.BOOTSTRAP_ADMIN_PASSWORD !== undefined &&
    /change-me|example|insecure|dev-only/i.test(config.BOOTSTRAP_ADMIN_PASSWORD)
  ) {
    throw new ConfigError([
      'BOOTSTRAP_ADMIN_PASSWORD looks like a placeholder; set a strong password in production',
    ]);
  }
  return config;
}

/** Whether interactive API docs (Swagger UI) should be served. Defaults to non-production only. */
export function apiDocsEnabled(config: Config): boolean {
  return config.ENABLE_API_DOCS ?? config.NODE_ENV !== 'production';
}
