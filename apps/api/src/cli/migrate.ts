import { loadConfig } from '../platform/config.js';
import { runMigrations } from '../platform/db/prepare.js';
import { createLogger } from '../platform/logger.js';

/**
 * Admin process (twelve-factor XII): apply pending migrations as the owner, provision the
 * runtime role when DATABASE_MIGRATION_URL is set (ADR-0092), and exit.
 */
const config = loadConfig();
await runMigrations(config, createLogger(config));
