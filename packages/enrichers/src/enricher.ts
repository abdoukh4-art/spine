import type { EnrichmentData, Indicator, IndicatorType, Verdict } from '@spine/shared-schema';

/**
 * What a provider found for one indicator.
 * - `found`: the provider knows the indicator. `data` is the typed payload
 *   (reputation, geo or asset), and `verdict` is set when the provider has an opinion.
 * - `not_found`: the provider answered, but knows nothing about it. That is a successful
 *   lookup, not an error: it must not trip a circuit breaker.
 */
export type LookupOutcome =
  | { kind: 'found'; data: EnrichmentData; verdict?: Verdict }
  | { kind: 'not_found' };

/** Per-call context handed to {@link Enricher.lookup}. */
export interface LookupContext {
  /**
   * Aborted when the attempt's time budget runs out or the caller gives up. Pass it to
   * whatever does the I/O (`fetch(url, { signal })`), so abandoned work really stops.
   */
  signal: AbortSignal;
}

/**
 * The enrichment port: **the extension point for new providers** (tutorial 02).
 *
 * An enricher is deliberately naive: it does one lookup and either answers or throws.
 * Timeouts, retries, circuit breaking and concurrency limits are NOT its job. They are
 * added around it by `ResilientEnricher` (ADR-0014), so every provider gets the same,
 * tested protection for free.
 *
 * Error contract for `lookup`:
 * - throw `TransientProviderError` for failures worth retrying (rate limited, 503, reset);
 * - throw anything else for permanent failures (they are not retried);
 * - honour `context.signal`, and reject when it aborts.
 */
export interface Enricher {
  /** Stable, unique provider name (e.g. `reputation`). Appears in results, metrics and logs. */
  readonly name: string;
  /** Indicator types this provider can handle in principle (shown by `GET /enrichment/providers`). */
  readonly indicatorTypes: readonly IndicatorType[];
  /** Whether to call {@link lookup} for this exact indicator (e.g. only private IPs). Must be pure and cheap. */
  supports(indicator: Indicator): boolean;
  /** Looks the indicator up. See the error contract above. */
  lookup(indicator: Indicator, context: LookupContext): Promise<LookupOutcome>;
}

/** Builds a `found` outcome. */
export function found(data: EnrichmentData, verdict?: Verdict): LookupOutcome {
  return verdict === undefined ? { kind: 'found', data } : { kind: 'found', data, verdict };
}

/** Builds a `not_found` outcome. */
export function notFound(): LookupOutcome {
  return { kind: 'not_found' };
}
