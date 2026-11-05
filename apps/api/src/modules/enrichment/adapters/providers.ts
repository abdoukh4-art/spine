import {
  createMockEnrichers,
  DEFAULT_RESILIENCE,
  ResilientEnricher,
  type ResilienceConfig,
  type ResilientEnricherOptions,
} from '@spine/enrichers';
import type { Config } from '../../../platform/config.js';

/** Resilience settings from the environment, on top of the package defaults (ADR-0044). */
export function resilienceFromConfig(config: Config): ResilienceConfig {
  return {
    ...DEFAULT_RESILIENCE,
    timeoutMs: config.ENRICHMENT_TIMEOUT_MS,
    retry: { ...DEFAULT_RESILIENCE.retry, maxAttempts: config.ENRICHMENT_MAX_ATTEMPTS },
  };
}

/**
 * The provider set for this process: the three fixture-driven mocks (no real network calls,
 * ADR-0018), each wrapped in its own resilience stack. A real provider would be added here
 * as one more `new ResilientEnricher(new MyEnricher(...), …)`.
 */
export function createProviders(
  config: Config,
  hooks: Pick<ResilientEnricherOptions, 'onStateChange' | 'onRetry'>,
): ResilientEnricher[] {
  const resilience = resilienceFromConfig(config);
  return createMockEnrichers({
    latencyMs: config.ENRICHMENT_LATENCY_MS,
    failureRate: config.ENRICHMENT_FAILURE_RATE,
    seed: config.ENRICHMENT_SEED,
  }).map((enricher) => new ResilientEnricher(enricher, resilience, hooks));
}
