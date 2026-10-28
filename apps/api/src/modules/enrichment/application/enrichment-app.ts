import {
  FAILED_ENRICHMENT_STATUSES,
  type Alert,
  type EnrichmentResult,
  type ProviderStatus,
} from '@spine/shared-schema';
import { NotFoundError } from '../../../platform/errors.js';
import type { Clock } from '../../../platform/runtime.js';
import type { EnrichmentPublicApi } from '../public-api.js';
import type { AlertEnricher, AlertLookup, EnrichmentRepository } from './ports.js';

/** What happened to one `alert.ingested` delivery. */
export type IngestedOutcome =
  | { kind: 'enriched'; results: number; failed: number }
  | { kind: 'duplicate' };

/** Collaborators of {@link EnrichmentApplication}. */
export interface EnrichmentApplicationDeps {
  enricher: AlertEnricher;
  repository: EnrichmentRepository;
  alerts: AlertLookup;
  clock: Clock;
}

/**
 * The enrichment use cases. Implements the module's public API and the event handler logic.
 *
 * The slow part (provider lookups) runs **outside** the database transaction, so a
 * transaction never stays open while we wait on a provider. The transaction only does the
 * quick, atomic part: inbox check, upserts and the `alert.enriched` event (ADR-0009, ADR-0040).
 */
export class EnrichmentApplication implements EnrichmentPublicApi {
  constructor(private readonly deps: EnrichmentApplicationDeps) {}

  /** Handles one delivery of `alert.ingested`. Idempotent per event id (ADR-0040). */
  async handleIngested(eventId: string, alert: Alert): Promise<IngestedOutcome> {
    if (await this.deps.repository.wasProcessed(eventId)) return { kind: 'duplicate' };
    const results = await this.deps.enricher.enrich(alert);
    const stored = await this.persistAndPublish(alert, results, eventId);
    if (stored === null) return { kind: 'duplicate' }; // a concurrent delivery won the race
    return { kind: 'enriched', results: results.length, failed: countFailed(results) };
  }

  /**
   * Re-runs enrichment now and persists it. Resolves with the alert's **merged** stored
   * results (what `alert.enriched` carries), not only this run's: a provider that fails now
   * keeps its earlier successful answer (ADR-0041).
   */
  async enrichAlert(
    alert: Alert,
    options: { providers?: string[]; signal?: AbortSignal } = {},
  ): Promise<EnrichmentResult[]> {
    const results = await this.deps.enricher.enrich(alert, options);
    return (await this.persistAndPublish(alert, results, null)) ?? [];
  }

  /**
   * `POST /alerts/:id/enrich`: looks the alert up, then {@link enrichAlert}.
   * @throws NotFoundError when the alert doesn't exist.
   */
  async reEnrichById(alertId: string): Promise<EnrichmentResult[]> {
    const alert = await this.deps.alerts.get(alertId);
    if (!alert) throw new NotFoundError('Alert', alertId);
    return this.enrichAlert(alert);
  }

  /** Latest stored results for an alert. */
  getForAlert(alertId: string): Promise<EnrichmentResult[]> {
    return this.deps.repository.listForAlert(alertId);
  }

  /** Live breaker and bulkhead state of every provider (this process only). */
  providerStatus(): ProviderStatus[] {
    return this.deps.enricher.status();
  }

  /** @returns the merged stored results, or null if `sourceEventId` was already processed. */
  private persistAndPublish(
    alert: Alert,
    results: readonly EnrichmentResult[],
    sourceEventId: string | null,
  ): Promise<EnrichmentResult[] | null> {
    return this.deps.repository.transaction(async (tx) => {
      if (
        sourceEventId !== null &&
        !(await tx.markProcessed(sourceEventId, alert.id, this.deps.clock.now()))
      ) {
        return null;
      }
      await tx.upsertResults(alert.id, results);
      const enrichments = await tx.listForAlert(alert.id);
      await tx.publish([
        { type: 'alert.enriched', aggregateId: alert.id, payload: { alert, enrichments } },
      ]);
      return enrichments;
    });
  }
}

function countFailed(results: readonly EnrichmentResult[]): number {
  return results.filter((r) => FAILED_ENRICHMENT_STATUSES.includes(r.status)).length;
}
