import type { PlatformDeps, SpineModule } from '../../platform/module.js';

/**
 * Auth module composition. Phase 0 scaffold: registers nothing yet.
 * See docs/modules/auth.md for the design.
 */
export function createAuthModule(_deps: PlatformDeps): { module: SpineModule } {
  return { module: { name: 'auth' } };
}
