import type { PlatformDeps, SpineModule } from '../../platform/module.js';

/**
 * Alerts module composition. Phase 0 scaffold: registers nothing yet.
 * See docs/modules/alerts.md for the design.
 */
export function createAlertsModule(_deps: PlatformDeps): { module: SpineModule } {
  return { module: { name: 'alerts' } };
}
