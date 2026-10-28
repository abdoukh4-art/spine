import { loadConfig } from '../platform/config.js';
import { createDatabase } from '../platform/db/database.js';
import { migrate } from '../platform/db/migrator.js';
import { createLogger } from '../platform/logger.js';

/** Admin process (twelve-factor XII): apply pending migrations and exit. */
const config = loadConfig();
const logger = createLogger(config);
const db = createDatabase({ connectionString: config.DATABASE_URL });
try {
  const result = await migrate(db, config.MIGRATIONS_DIR);
  logger.info(
    { applied: result.applied, alreadyApplied: result.alreadyApplied.length },
    'migrations complete',
  );
} finally {
  await db.destroy();
}
