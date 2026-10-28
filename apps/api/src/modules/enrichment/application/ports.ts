import type { Alert, EnrichmentResult, ProviderStatus } from '@spine/shared-schema';
import type { NewDomainEvent } from '../../../platform/events/types.js';

/**
 * Port: read an alert snapshot by id. Needed by `POST /alerts/:id/enrich`, which only has
 * the id. Implemented by the alerts module's public API (`AlertsPublicApi.get`); until that
 * is wired, composition.ts passes a placeholder (marked `// INTEGRATION`).
 */
export interface AlertLookup {
  get(alertId: string): Promise<Alert | null>;
}

/**
 * Port: run every provider lookup for an alert. Implemented by `EnrichmentService` from
 * `@spine/enrichers`, which never rejects because of a provider failure.
 */
export interface AlertEnricher {
  enrich(
    alert: Pick<Alert, 'indicators' | 'host'>,
    options?: { providers?: readonly string[] | undefined; signal?: AbortSignal | undefined },
  ): Promise<EnrichmentResult[]>;
  status(): ProviderStatus[];
}

/** Writes that must commit atomically with the `alert.enriched` event (ADR-0009). */
export interface EnrichmentTransaction {
  /**
   * Records that the delivery `eventId` has been handled (idempotent receiver, ADR-0040).
   * @returns false when it already was, in which case the caller must write nothing.
   */
  markProcessed(eventId: string, alertId: string, at: Date): Promise<boolean>;
  /**
   * Upserts one row per (provider, indicator). A newer result replaces an older one, except
   * that a failure never replaces a success (ADR-0041).
   */
  upsertResults(alertId: string, results: readonly EnrichmentResult[]): Promise<void>;
  /** All stored results for the alert, as seen inside this transaction. */
  listForAlert(alertId: string): Promise<EnrichmentResult[]>;
  /** Publishes domain events in this transaction (outbox). */
  publish(events: readonly NewDomainEvent[]): Promise<void>;
}

/** Port: the module's persistence. */
export interface EnrichmentRepository {
  /** Runs `work` in one database transaction. */
  transaction<T>(work: (tx: EnrichmentTransaction) => Promise<T>): Promise<T>;
  listForAlert(alertId: string): Promise<EnrichmentResult[]>;
  /** True if the delivery `eventId` was already handled (cheap pre-check before doing lookups). */
  wasProcessed(eventId: string): Promise<boolean>;
}
