import type { Meter } from '@opentelemetry/api';
import type { ScoreExplanation } from '@spine/shared-schema';
import { getMeter } from '../../../platform/telemetry/index.js';

/** Scoring instruments (names agreed in the Phase 1 brief, ADR-0019). */
export interface ScoringMetrics {
  /** A new or changed score was stored and `alert.scored` published. */
  recordScored(explanation: ScoreExplanation): void;
}

/** Bucket edges aligned with the severity bands (20/40/60/80, ADR-0015). */
const SCORE_BUCKETS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/**
 * - `spine_alerts_scored{severity}` (counter): how many alerts land in each band.
 * - `spine_alert_score` (histogram, unitless 0–100): the score distribution. A ruleset
 *   change that shifts it is visible on the dashboard before analysts complain.
 *
 * Recorded only when a score is actually published, so redeliveries don't inflate counts.
 */
export function createScoringMetrics(meter: Meter = getMeter()): ScoringMetrics {
  const scored = meter.createCounter('spine_alerts_scored', {
    description: 'Alerts scored (new or changed scores only), by derived severity',
  });
  const distribution = meter.createHistogram('spine_alert_score', {
    description: 'Distribution of alert scores (0-100)',
    advice: { explicitBucketBoundaries: SCORE_BUCKETS },
  });
  return {
    recordScored: (e) => {
      scored.add(1, { severity: e.severity });
      distribution.record(e.score);
    },
  };
}
