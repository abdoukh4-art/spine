import type { Enricher } from '../enricher.js';
import { createAssetInventoryEnricher } from './asset-inventory.js';
import type { FaultInjectionOptions } from './fault-injection.js';
import { createGeoEnricher } from './geo.js';
import { createReputationEnricher } from './reputation.js';

/**
 * The three bundled mock providers (reputation, geo, asset inventory) with the same fault
 * injection settings. Each gets its own seed (`seed`, `seed + 1`, `seed + 2`), so their
 * failures are independent of each other but still reproducible.
 */
export function createMockEnrichers(options: FaultInjectionOptions = {}): Enricher[] {
  const seed = options.seed ?? 1;
  return [
    createReputationEnricher({ ...options, seed }),
    createGeoEnricher({ ...options, seed: seed + 1 }),
    createAssetInventoryEnricher({ ...options, seed: seed + 2 }),
  ];
}
