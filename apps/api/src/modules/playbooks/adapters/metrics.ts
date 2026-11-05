import { getMeter } from '../../../platform/telemetry/index.js';
import type { ExecutionObserver } from '../application/ports.js';
import type { RunFinishedListener } from './postgres/run-repository.js';

/**
 * Playbook metrics (ADR-0019), named per the Phase 1 agreement. Labels are low-cardinality
 * on purpose: playbook id, status, step type. Never run IDs or alert IDs.
 */
export class PlaybookMetrics implements ExecutionObserver, RunFinishedListener {
  private readonly meter = getMeter();
  private readonly runs = this.meter.createCounter('spine_playbook_runs', {
    description: 'Playbook runs that reached a terminal status',
  });
  private readonly runDuration = this.meter.createHistogram('spine_playbook_run_duration_seconds', {
    description:
      'Wall-clock time from run creation to its terminal status (includes approval waits)',
  });
  private readonly stepDuration = this.meter.createHistogram(
    'spine_playbook_step_duration_seconds',
    {
      description: 'Duration of one step attempt',
    },
  );

  /**
   * @param countPending reads the number of pending approvals for the
   *   `spine_approvals_pending` gauge (observed only when metrics are scraped).
   */
  constructor(countPending: () => Promise<number>) {
    const gauge = this.meter.createObservableGauge('spine_approvals_pending', {
      description: 'Approval requests waiting for a human decision',
    });
    gauge.addCallback(async (result) => {
      try {
        result.observe(await countPending());
      } catch {
        // A failed scrape-time query must not break the exporter.
      }
    });
  }

  runFinished(info: { playbookId: string; status: string; durationMs: number }): void {
    const labels = { playbook: info.playbookId, status: info.status };
    this.runs.add(1, labels);
    this.runDuration.record(info.durationMs / 1000, labels);
  }

  stepFinished(info: { type: string; status: 'succeeded' | 'failed'; durationMs: number }): void {
    this.stepDuration.record(info.durationMs / 1000, { type: info.type, status: info.status });
  }
}
