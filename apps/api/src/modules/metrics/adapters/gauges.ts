import { getMeter } from '../../../platform/telemetry/index.js';
import type { Logger } from '../../../platform/logger.js';
import type { BackgroundTask } from '../../../platform/module.js';
import type { Clock } from '../../../platform/runtime.js';
import type { MetricsReadModel } from '../application/get-metrics-summary.js';
import { playbookStatsFrom } from '../domain/soc-metrics.js';

const ROLLING_WINDOW_MS = 24 * 3_600_000;
const REFRESH_MS = 30_000;

/**
 * Publishes rolling 24 h MTTD/MTTR/success-rate as Prometheus gauges for the Grafana
 * dashboard (ADR-0019). Values are recomputed at most every 30 s, not on every scrape,
 * so a scrape never triggers heavy queries.
 */
export interface SocGaugeValues {
  mttd: number;
  mttr: number;
  successRate: number;
  open: number;
}

export function createSocGaugesTask(
  readModel: MetricsReadModel,
  clock: Clock,
  logger: Logger,
): BackgroundTask & { values(): SocGaugeValues } {
  let timer: NodeJS.Timeout | undefined;
  let latest: SocGaugeValues = { mttd: NaN, mttr: NaN, successRate: NaN, open: NaN };

  const refresh = async (): Promise<void> => {
    try {
      const to = clock.now();
      const window = { from: new Date(to.getTime() - ROLLING_WINDOW_MS), to };
      const [alerts, runs] = await Promise.all([
        readModel.alertStats(window),
        readModel.runStats(window),
      ]);
      latest = {
        mttd: alerts.mttd.meanSeconds ?? NaN,
        mttr: alerts.mttr.meanSeconds ?? NaN,
        successRate: playbookStatsFrom(runs).successRate ?? NaN,
        open: alerts.mttr.openCount,
      };
    } catch (err) {
      logger.warn({ err }, 'failed to refresh SOC gauges');
    }
  };

  return {
    name: 'metrics.soc-gauges',
    /** Latest computed values (NaN = no data yet); exposed for tests and debugging. */
    values: () => latest,
    start: async () => {
      const meter = getMeter();
      const observe = (name: string, description: string, read: () => number) =>
        meter.createObservableGauge(name, { description }).addCallback((result) => {
          const value = read();
          if (!Number.isNaN(value)) result.observe(value);
        });
      observe(
        'spine_mttd_seconds',
        'Mean time to detect over the last 24 h (ADR-0026)',
        () => latest.mttd,
      );
      observe(
        'spine_mttr_seconds',
        'Mean time to resolve over the last 24 h (ADR-0026)',
        () => latest.mttr,
      );
      observe(
        'spine_playbook_success_ratio',
        'Playbook success rate over the last 24 h',
        () => latest.successRate,
      );
      observe(
        'spine_alerts_open_received_24h',
        'Alerts received in the last 24 h that are still open',
        () => latest.open,
      );
      await refresh();
      timer = setInterval(() => void refresh(), REFRESH_MS);
      timer.unref();
    },
    stop: () => {
      clearInterval(timer);
      return Promise.resolve();
    },
  };
}
