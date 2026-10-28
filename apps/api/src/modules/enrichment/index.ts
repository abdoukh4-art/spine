import type { PlatformDeps, SpineModule } from '../../platform/module.js';

/**
 * Enrichment module composition. Phase 0 scaffold: registers nothing yet.
 * See docs/modules/enrichment.md for the design.
 */
export function createEnrichmentModule(_deps: PlatformDeps): { module: SpineModule } {
  return { module: { name: 'enrichment' } };
}
