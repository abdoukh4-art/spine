import type { PlatformDeps, SpineModule } from '../../platform/module.js';

/**
 * Metrics module composition. Phase 0 scaffold: registers nothing yet.
 * See docs/modules/metrics.md for the design.
 */
export function createMetricsModule(_deps: PlatformDeps): { module: SpineModule } {
  return { module: { name: 'metrics' } };
}
