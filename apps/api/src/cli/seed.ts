import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logger.js';

/** Demo seeder. Phase 0 scaffold — implemented in the demo workstream (Phase 2). */
const config = loadConfig();
createLogger(config).info('seed: nothing to do yet');
