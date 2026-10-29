import type { Meter } from '@opentelemetry/api';
import type { CircuitState, EnrichmentResult } from '@spine/shared-schema';
import { getMeter } from '../../../platform/telemetry/index.js';
import { circuitGaugeValue } from '../domain/circuit-gauge.js';

/** Enrichment instruments (names agreed in the Phase 1 brief, ADR-0019). */
export interface EnrichmentMetrics {
  /** One lookup finished (any status). */
  recordLookup(result: EnrichmentResult): void;
  /** A provider's breaker changed state (or its initial state, at startup). */
  recordCircuit(provider: string, state: CircuitState): void;
}

/**
 * Lookup latency buckets in seconds: mock providers answer in ~30 ms, the per-attempt
 * timeout defaults to 1 s and three attempts with backoff can approach 3.5 s.
 */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * - `spine_enrichment_duration_seconds{provider,status}` (histogram): RED "duration" and
 *   "errors" per provider in one instrument (status = ok | not_found | timeout | …).
 * - `spine_enrichment_circuit_state{provider}` (gauge): 0 closed, 1 half_open, 2 open.
 *   Labels never include indicator values (cardinality, ADR-0019).
 */
export function createEnrichmentMetrics(meter: Meter = getMeter()): EnrichmentMetrics {
  const duration = meter.createHistogram('spine_enrichment_duration_seconds', {
    description: 'Duration of one enrichment lookup (all attempts), by provider and outcome',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  });
  const circuit = meter.createGauge('spine_enrichment_circuit_state', {
    description: 'Circuit breaker state per enrichment provider: 0 closed, 1 half_open, 2 open',
  });
  return {
    recordLookup: (r) => {
      duration.record(r.durationMs / 1000, { provider: r.provider, status: r.status });
    },
    recordCircuit: (provider, state) => {
      circuit.record(circuitGaugeValue(state), { provider });
    },
  };
}
