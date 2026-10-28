import type { PlatformDeps, SpineModule } from '../../platform/module.js';

/**
 * Ingestion module composition. Phase 0 scaffold: registers nothing yet.
 * See docs/modules/ingestion.md for the design.
 */
export function createIngestionModule(_deps: PlatformDeps): { module: SpineModule } {
  return { module: { name: 'ingestion' } };
}
