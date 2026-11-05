import type { Indicator, IndicatorType } from '@spine/shared-schema';
import type { Enricher, LookupContext, LookupOutcome } from '../enricher.js';
import { TransientProviderError } from '../resilience/errors.js';
import { realScheduler, sleep, type Scheduler } from '../time.js';
import { mulberry32 } from './prng.js';

/**
 * Knobs that make a mock provider behave like a real, imperfect one (ADR-0045).
 * Same seed + same call order = same failures, every run.
 */
export interface FaultInjectionOptions {
  /** Simulated response time of every call, in ms. Default 0. */
  latencyMs?: number;
  /** Probability in [0, 1] that a call fails with a `TransientProviderError`. Default 0. */
  failureRate?: number;
  /** PRNG seed for the failure draws. Default 1. */
  seed?: number;
  /** Clock used for the simulated latency. Default: the real scheduler. */
  scheduler?: Scheduler;
}

/** What a concrete mock provides: its identity and a pure fixture lookup. */
export interface MockDefinition {
  name: string;
  indicatorTypes: readonly IndicatorType[];
  supports(indicator: Indicator): boolean;
  resolve(indicator: Indicator): LookupOutcome;
}

/**
 * Turns a pure fixture lookup into an {@link Enricher} with simulated latency and seeded
 * failures. The failure draw happens **before** the latency, in call order, so concurrency
 * timing can't change which calls fail. The latency honours the abort signal, so a
 * timeout really cancels the simulated work, as a real HTTP client would.
 */
export function createMockEnricher(
  definition: MockDefinition,
  options: FaultInjectionOptions = {},
): Enricher {
  const latencyMs = Math.max(0, options.latencyMs ?? 0);
  const failureRate = Math.min(1, Math.max(0, options.failureRate ?? 0));
  const random = mulberry32(options.seed ?? 1);
  const scheduler = options.scheduler ?? realScheduler;

  return {
    name: definition.name,
    indicatorTypes: definition.indicatorTypes,
    supports: (indicator) => definition.supports(indicator),
    async lookup(indicator: Indicator, context: LookupContext): Promise<LookupOutcome> {
      const fails = random() < failureRate;
      if (latencyMs > 0) await sleep(scheduler, latencyMs, context.signal);
      if (fails) {
        throw new TransientProviderError(`${definition.name}: simulated provider failure`);
      }
      return definition.resolve(indicator);
    },
  };
}
