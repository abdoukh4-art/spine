import type { Counter } from '@opentelemetry/api';
import { getMeter } from '../../../platform/telemetry/index.js';

/**
 * Ingestion metrics (ADR-0019, names agreed in the Phase 1 brief). Counters carry no
 * `_total` suffix: the Prometheus exporter appends it.
 *
 * `source` is the *channel*, never a value taken from the payload, to keep label cardinality
 * bounded: `api`, `batch:<format>` or `webhook:<configured source id>`.
 */
export type IngestOutcomeLabel = 'created' | 'deduplicated' | 'rejected';

/** Lazily created instruments (the meter is a no-op until the SDK starts). */
export interface IngestionMetrics {
  ingested(source: string, outcome: IngestOutcomeLabel, count?: number): void;
  backpressureRejected(): void;
}

/** Creates the ingestion instruments on the global meter. */
export function createIngestionMetrics(): IngestionMetrics {
  let ingested: Counter | undefined;
  let rejections: Counter | undefined;
  return {
    ingested(source, outcome, count = 1) {
      if (count <= 0) return;
      ingested ??= getMeter().createCounter('spine_alerts_ingested', {
        description: 'Alerts received by ingestion, by channel and outcome',
      });
      ingested.add(count, { source, outcome });
    },
    backpressureRejected() {
      rejections ??= getMeter().createCounter('spine_ingest_backpressure_rejections', {
        description:
          'Ingestion requests rejected with 503 because the outbox backlog was too large',
      });
      rejections.add(1);
    },
  };
}
