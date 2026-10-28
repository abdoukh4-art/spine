import type { EventHandler } from '../../../../platform/events/types.js';
import type { RunQueue, RunRepository } from '../../application/ports.js';
import type { RunService } from '../../application/runs.js';

/**
 * Domain-event subscribers of the playbooks module (ADR-0009). Delivery is at-least-once,
 * so each one is idempotent:
 * - trigger matching creates at most one automatic run per (playbook, alert) (unique index);
 * - enqueueing uses deterministic job IDs, and an extra `advance` on a run is a no-op.
 */
export function playbookSubscribers(deps: {
  runs: RunService;
  repository: Pick<RunRepository, 'load'>;
  queue: RunQueue;
}): EventHandler[] {
  const onAlertScored: EventHandler<'alert.scored'> = {
    name: 'playbooks.on-alert-scored',
    eventType: 'alert.scored',
    handle: async (event) => {
      const { alert, score, enrichments } = event.payload;
      await deps.runs.triggerForScoredAlert({ alert, score, enrichments });
    },
  };

  const onRunRequested: EventHandler<'playbook.run.requested'> = {
    name: 'playbooks.enqueue-requested-run',
    eventType: 'playbook.run.requested',
    handle: (event) => deps.queue.enqueue(event.payload.runId, 1),
  };

  const onApprovalDecided: EventHandler<'approval.decided'> = {
    name: 'playbooks.resume-on-approval-decided',
    eventType: 'approval.decided',
    handle: async (event) => {
      const loaded = await deps.repository.load(event.payload.runId);
      const lastSeq = loaded?.events.at(-1)?.seq;
      if (lastSeq !== undefined) await deps.queue.enqueue(event.payload.runId, lastSeq);
    },
  };

  return [onAlertScored, onRunRequested, onApprovalDecided] as unknown as EventHandler[];
}
