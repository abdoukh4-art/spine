import { getMeter } from '../../../platform/telemetry/index.js';
import type { AuthMetrics, LoginOutcome } from '../application/ports.js';

/**
 * OpenTelemetry instruments of the auth module (ADR-0019, naming per the Phase 1 brief):
 * - `spine_auth_logins{outcome}`: counter, outcome ∈ success | failure | throttled;
 * - `spine_auth_refresh_reuse_detected`: counter. Any increase deserves an alert: it means
 *   a refresh token was very likely stolen.
 * Counters have no `_total` suffix here; the Prometheus exporter appends it.
 * Labels never contain user ids, emails or IPs (cardinality and privacy).
 */
export function createAuthMetrics(): AuthMetrics {
  const meter = getMeter();
  const logins = meter.createCounter('spine_auth_logins', {
    description: 'Login attempts by outcome',
  });
  const reuse = meter.createCounter('spine_auth_refresh_reuse_detected', {
    description: 'Revoked refresh tokens presented again (likely token theft)',
  });
  return {
    loginAttempt: (outcome: LoginOutcome) => logins.add(1, { outcome }),
    refreshReuseDetected: () => reuse.add(1),
  };
}
