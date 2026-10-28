import type { PlatformDeps, SpineModule } from '../../platform/module.js';

/**
 * Scoring module composition. Phase 0 scaffold: registers nothing yet.
 * See docs/modules/scoring.md for the design.
 */
export function createScoringModule(_deps: PlatformDeps): { module: SpineModule } {
  return { module: { name: 'scoring' } };
}
