import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { createDatabase, type Db } from './database.js';
import { migrate } from './migrator.js';
import { ensureRuntimeLogin, inspectRuntimePrivileges, isPrivileged } from './roles.js';

/**
 * Admin step (twelve-factor XII): apply migrations as the owner and, when a separate migration
 * URL is configured, provision the runtime login role from DATABASE_URL (ADR-0092).
 */
export async function runMigrations(config: Config, logger: Logger): Promise<void> {
  const ownerUrl = config.DATABASE_MIGRATION_URL ?? config.DATABASE_URL;
  const ownerDb = createDatabase({
    connectionString: ownerUrl,
    poolMax: 1,
    applicationName: 'spine-migrate',
  });
  try {
    const result = await migrate(ownerDb, config.MIGRATIONS_DIR);
    logger.info(
      { applied: result.applied, alreadyApplied: result.alreadyApplied.length },
      'migrations complete',
    );
    if (config.DATABASE_MIGRATION_URL) {
      const login = await ensureRuntimeLogin(ownerDb, ownerUrl, config.DATABASE_URL);
      logger.info({ role: login.role, status: login.status }, 'runtime database role ready');
    }
  } finally {
    await ownerDb.destroy();
  }
}

export class PrivilegedDatabaseRoleError extends Error {
  constructor(role: string) {
    super(
      `DATABASE_URL connects as "${role}", which can rewrite the audit log (owner, superuser or ` +
        'UPDATE/DELETE on audit_log). Use a runtime role: set DATABASE_MIGRATION_URL to the owner ' +
        'and DATABASE_URL to a separate login (see docs/operations/deployment.md), or set ' +
        'DB_ALLOW_PRIVILEGED_ROLE=true to accept the risk (ADR-0092).',
    );
    this.name = 'PrivilegedDatabaseRoleError';
  }
}

/**
 * Startup guard: production refuses a runtime role that could tamper with the audit log, unless
 * explicitly allowed. Elsewhere it only warns, because single-role development is convenient.
 */
export async function checkRuntimeRole(db: Db, config: Config, logger: Logger): Promise<void> {
  const privileges = await inspectRuntimePrivileges(db);
  if (!isPrivileged(privileges)) {
    logger.info({ role: privileges.role }, 'database runtime role is least-privilege');
    return;
  }
  if (config.NODE_ENV === 'production' && !config.DB_ALLOW_PRIVILEGED_ROLE) {
    throw new PrivilegedDatabaseRoleError(privileges.role);
  }
  logger.warn(
    { ...privileges },
    'database runtime role can rewrite the audit log; use a separate runtime role in production (ADR-0092)',
  );
}
