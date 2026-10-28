import type { PlatformDeps, SpineModule } from '../../platform/module.js';

/**
 * Playbooks module composition. Phase 0 scaffold: registers nothing yet.
 * See docs/modules/playbooks.md for the design.
 */
export function createPlaybooksModule(_deps: PlatformDeps): { module: SpineModule } {
  return { module: { name: 'playbooks' } };
}
