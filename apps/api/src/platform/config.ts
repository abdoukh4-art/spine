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
  /**
   * Owner credentials for migrations (ADR-0092). When set, migrations run with this URL and the
   * runtime role from DATABASE_URL is created/updated as a member of `spine_runtime`.
   */
  DATABASE_MIGRATION_URL: z.url().optional(),
  /** Production refuses to start when DATABASE_URL can rewrite the audit log, unless this is true. */
  DB_ALLOW_PRIVILEGED_ROLE: bool.default(false),
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

  /** Per-source (webhooks) / per-client-IP (analyst endpoints) ingestion limit (ADR-0024). */
  INGEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(6000),
  INGEST_MAX_BACKLOG: z.coerce.number().int().min(1).default(10_000),
  /** Concurrent ingest requests per API process before answering 503 at once (ADR-0093). */
  INGEST_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(10_000).default(16),
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

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(50),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  EVENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(8),
  PLAYBOOK_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  PLAYBOOK_APPROVAL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),

  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

  CONFIG_DIR: z.string().default('config'),
  SIMULATION_LATENCY_MS: z.coerce.number().int().min(0).default(50),
  SIMULATION_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  // Enrichment (ADR-0014, ADR-0044, ADR-0045): mock provider behaviour + resilience budget.
  ENRICHMENT_LATENCY_MS: z.coerce.number().int().min(0).max(60_000).default(30),
  ENRICHMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  ENRICHMENT_SEED: z.coerce.number().int().default(42),
  ENRICHMENT_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(1000),
  ENRICHMENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  ENRICHMENT_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),

  // Scoring (ADR-0015, ADR-0046): ruleset file, relative to CONFIG_DIR.
  SCORING_RULESET_FILE: z.string().min(1).default('scoring/ruleset.v1.yaml'),

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
  if (config.NODE_ENV === 'production') {
    // Security review F1: the .env.example values are public; refuse them in production.
    const placeholderSources = Object.entries(config.WEBHOOK_SOURCES_JSON)
      .filter(([, source]) => /change-me|example|insecure|dev-only/i.test(source.secret))
      .map(([id]) => id);
    if (placeholderSources.length > 0) {
      throw new ConfigError([
        `WEBHOOK_SOURCES_JSON: placeholder secret for source(s) ${placeholderSources.join(', ')}; generate random secrets in production`,
      ]);
    }
    if (!config.COOKIE_SECURE) {
      throw new ConfigError([
        'COOKIE_SECURE must be true in production (refresh cookies need HTTPS)',
      ]);
    }
  }
  return config;
}

/** Whether interactive API docs (Swagger UI) should be served. Defaults to non-production only. */
export function apiDocsEnabled(config: Config): boolean {
  return config.ENABLE_API_DOCS ?? config.NODE_ENV !== 'production';
}
