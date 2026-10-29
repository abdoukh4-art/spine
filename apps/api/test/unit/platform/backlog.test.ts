import { describe, expect, it } from 'vitest';
import {
  pipelineBacklogProbe,
  type PendingJobCounter,
} from '../../../src/platform/events/backlog.js';

const queue = (counts: Record<string, number>): PendingJobCounter => ({
  getJobCounts: () => Promise.resolve(counts),
});

describe('pipelineBacklogProbe', () => {
  it('adds undispatched outbox events and pending queue jobs (not active ones)', async () => {
    const probe = pipelineBacklogProbe({
      outbox: () => Promise.resolve(3),
      queue: queue({ waiting: 100, prioritized: 5, delayed: 7, active: 8, failed: 2 }),
    });
    await expect(probe()).resolves.toBe(3 + 100 + 5 + 7);
  });

  it('sees a backlog that lives only in the queue (the 400/s load-test case)', async () => {
    const probe = pipelineBacklogProbe({
      outbox: () => Promise.resolve(0),
      queue: queue({ waiting: 29_286 }),
    });
    await expect(probe()).resolves.toBe(29_286);
  });

  it('counts only the outbox without Redis, or when Redis errors (fail open)', async () => {
    await expect(
      pipelineBacklogProbe({ outbox: () => Promise.resolve(4), queue: null })(),
    ).resolves.toBe(4);
    const broken: PendingJobCounter = {
      getJobCounts: () => Promise.reject(new Error('OOM command not allowed')),
    };
    await expect(
      pipelineBacklogProbe({ outbox: () => Promise.resolve(4), queue: broken })(),
    ).resolves.toBe(4);
  });
});
