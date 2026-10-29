/** The subset of a BullMQ `Queue` the backlog probe needs (easy to fake in tests). */
export interface PendingJobCounter {
  getJobCounts(...states: string[]): Promise<Record<string, number>>;
}

/** Job states that are work still to do. `active` is excluded: it's already being done. */
export const PENDING_JOB_STATES = ['waiting', 'prioritized', 'delayed'] as const;

/**
 * Measures the whole asynchronous pipeline's backlog for ingest back-pressure (ADR-0093):
 * domain events not yet dispatched by the relay (outbox) **plus** event deliveries queued in
 * BullMQ but not yet processed. Each event becomes one job per subscriber, so the unit is
 * "pending deliveries", not alerts.
 *
 * Counting only the outbox (ADR-0034) missed the real buffer: the relay moves events into Redis
 * within milliseconds, so under overload the outbox stays near zero while the queue grows
 * without bound (29 k jobs in the 400/s load test). If Redis can't be queried, the queue counts as
 * 0 (fail open, as the rate limiter does, ADR-0090): readiness already reports Redis down.
 */
export function pipelineBacklogProbe(sources: {
  outbox: () => Promise<number>;
  queue: PendingJobCounter | null;
}): () => Promise<number> {
  return async () => {
    const [outbox, queued] = await Promise.all([sources.outbox(), pendingJobs(sources.queue)]);
    return outbox + queued;
  };
}

async function pendingJobs(queue: PendingJobCounter | null): Promise<number> {
  if (!queue) return 0;
  try {
    const counts = await queue.getJobCounts(...PENDING_JOB_STATES);
    return PENDING_JOB_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  } catch {
    return 0;
  }
}
