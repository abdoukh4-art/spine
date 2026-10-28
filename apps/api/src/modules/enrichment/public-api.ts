import type { Alert, EnrichmentResult, ProviderStatus } from '@spine/shared-schema';

/** Public API of the Enrichment module. Other modules may import ONLY this file. */
export interface EnrichmentPublicApi {
  /** Latest stored enrichment results for an alert (empty if not enriched yet). */
  getForAlert(alertId: string): Promise<EnrichmentResult[]>;
  /**
   * Enriches an alert now (used by the playbook `enrich` step and the re-enrich endpoint),
   * persists the results and returns them. Never throws because of a provider failure:
   * failures are returned as results with a failed status (ADR-0014).
   */
  enrichAlert(
    alert: Alert,
    options?: { providers?: string[]; signal?: AbortSignal },
  ): Promise<EnrichmentResult[]>;
  /** Live provider health (circuit-breaker state, bulkhead usage). */
  providerStatus(): ProviderStatus[];
}
