import type { CircuitState } from '@spine/shared-schema';

/**
 * Numeric encoding of a circuit-breaker state for the `spine_enrichment_circuit_state`
 * gauge (agreed in the Phase 1 brief): 0 = closed (healthy), 1 = half_open (probing),
 * 2 = open (failing fast). Ordered by "badness", so `max by (provider)` over time and an
 * alert rule such as `== 2 for 5m` read naturally.
 */
export function circuitGaugeValue(state: CircuitState): 0 | 1 | 2 {
  switch (state) {
    case 'closed':
      return 0;
    case 'half_open':
      return 1;
    case 'open':
      return 2;
  }
}
