import type { MetricsQuery, MetricsSummary } from '@spine/shared-schema';
import { ValidationError } from '../../../platform/errors.js';
import type { Clock } from '../../../platform/runtime.js';
import {
  buildMetricsSummary,
  type AlertTimes,
  type RunTimes,
  type TimeWindow,
} from '../domain/soc-metrics.js';

/**
 * Port: the read model the Metrics module needs. It's implemented in the composition root
 * on top of the Alerts and Playbooks public APIs, so Metrics never reads other modules' tables.
 */
export interface MetricsReadModel {
  /** Alerts whose `receivedAt` is in [from, to). */
  alertsReceivedBetween(window: TimeWindow): Promise<AlertTimes[]>;
  /** Runs that finished in [from, to), plus runs that are still in flight. */
  runsBetween(window: TimeWindow): Promise<RunTimes[]>;
}

export const DEFAULT_WINDOW_MS = 7 * 24 * 3_600_000;
export const MAX_WINDOW_MS = 90 * 24 * 3_600_000;

/** Resolves an optional query into a concrete, validated window (default: the last 7 days). */
export function resolveWindow(query: MetricsQuery, clock: Clock): TimeWindow {
  const to = query.to ? new Date(query.to) : clock.now();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_WINDOW_MS);
  if (from >= to) {
    throw new ValidationError('`from` must be before `to`', [
      { path: 'query.from', message: 'must be before to' },
    ]);
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw new ValidationError('window must be at most 90 days', [
      { path: 'query', message: 'window must be at most 90 days' },
    ]);
  }
  return { from, to };
}

/** Use case: compute the SOC metrics summary for a window (ADR-0026). */
export class GetMetricsSummary {
  constructor(
    private readonly readModel: MetricsReadModel,
    private readonly clock: Clock,
  ) {}

  async execute(query: MetricsQuery): Promise<MetricsSummary> {
    const window = resolveWindow(query, this.clock);
    const [alerts, runs] = await Promise.all([
      this.readModel.alertsReceivedBetween(window),
      this.readModel.runsBetween(window),
    ]);
    return buildMetricsSummary(window, alerts, runs);
  }
}
