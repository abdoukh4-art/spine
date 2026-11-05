import type { Indicator, ProviderStatus } from '@spine/shared-schema';
import type { Enricher, LookupOutcome } from './enricher.js';
import { Bulkhead } from './resilience/bulkhead.js';
import { CircuitBreaker, type CircuitState } from './resilience/circuit-breaker.js';
import { composeResilience, type ResilientCall } from './resilience/compose.js';
import { realScheduler, type Scheduler } from './time.js';

/** Tunables of one provider's resilience stack (ADR-0014, ADR-0044). */
export interface ResilienceConfig {
  /** Budget of one attempt, in ms. */
  timeoutMs: number;
  retry: { maxAttempts: number; baseMs: number; capMs: number };
  breaker: {
    failureRateThreshold: number;
    windowSize: number;
    minimumCalls: number;
    cooldownMs: number;
    halfOpenMaxCalls: number;
  };
  bulkhead: { maxConcurrent: number; maxQueue: number };
}

/**
 * Defaults, sized for mock providers answering in tens of milliseconds (see ADR-0044 for
 * the reasoning behind each number).
 */
export const DEFAULT_RESILIENCE: ResilienceConfig = {
  timeoutMs: 1000,
  retry: { maxAttempts: 3, baseMs: 50, capMs: 1000 },
  breaker: {
    failureRateThreshold: 0.5,
    windowSize: 20,
    minimumCalls: 10,
    cooldownMs: 10_000,
    halfOpenMaxCalls: 1,
  },
  bulkhead: { maxConcurrent: 16, maxQueue: 64 },
};

/** Collaborators for {@link ResilientEnricher}; all optional. */
export interface ResilientEnricherOptions {
  scheduler?: Scheduler;
  /** Jitter source. Defaults to `Math.random`. */
  random?: () => number;
  /** Breaker transitions, labelled with the provider name (wire to a gauge). */
  onStateChange?: (provider: string, change: { from: CircuitState; to: CircuitState }) => void;
  /** Retries, labelled with the provider name (wire to a log line or counter). */
  onRetry?: (provider: string, info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * The provider-facing view of an enricher wrapped in its resilience stack. The enrichment
 * service depends on this interface, not on the concrete class, so tests can fake it.
 */
export interface ResilientProvider {
  readonly name: string;
  supports(indicator: Indicator): boolean;
  /** Looks up through bulkhead → breaker → retry → timeout. Rejects with the stack's errors. */
  lookup(indicator: Indicator, signal?: AbortSignal): Promise<LookupOutcome>;
  /** Live health: breaker state and bulkhead usage. */
  status(): ProviderStatus;
}

/**
 * An {@link Enricher} with its own bulkhead and circuit breaker. Both are **per provider**
 * (ADR-0014): a failing geo provider opens only its own breaker, and a slow one fills only
 * its own bulkhead.
 */
export class ResilientEnricher implements ResilientProvider {
  readonly name: string;
  readonly breaker: CircuitBreaker;
  readonly bulkhead: Bulkhead;
  private readonly call: ResilientCall;

  constructor(
    private readonly enricher: Enricher,
    config: ResilienceConfig = DEFAULT_RESILIENCE,
    options: ResilientEnricherOptions = {},
  ) {
    this.name = enricher.name;
    const scheduler = options.scheduler ?? realScheduler;
    this.bulkhead = new Bulkhead(config.bulkhead.maxConcurrent, config.bulkhead.maxQueue);
    this.breaker = new CircuitBreaker({
      ...config.breaker,
      scheduler,
      onStateChange: (change) => options.onStateChange?.(this.name, change),
    });
    this.call = composeResilience({
      bulkhead: this.bulkhead,
      breaker: this.breaker,
      timeoutMs: config.timeoutMs,
      scheduler,
      retry: {
        ...config.retry,
        ...(options.random ? { random: options.random } : {}),
        onRetry: (info) => options.onRetry?.(this.name, info),
      },
    });
  }

  /** Delegates to the wrapped enricher. */
  supports(indicator: Indicator): boolean {
    return this.enricher.supports(indicator);
  }

  /** Looks the indicator up through the resilience stack. */
  lookup(indicator: Indicator, signal?: AbortSignal): Promise<LookupOutcome> {
    return this.call(
      (attemptSignal) => this.enricher.lookup(indicator, { signal: attemptSignal }),
      signal,
    );
  }

  /** Snapshot for `GET /enrichment/providers`. */
  status(): ProviderStatus {
    return {
      name: this.name,
      supports: [...this.enricher.indicatorTypes],
      circuit: this.breaker.state,
      inFlight: this.bulkhead.inFlight,
      queued: this.bulkhead.queued,
    };
  }
}
