import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedis } from '../../src/platform/queue/bullmq.js';
import {
  BullMqRunQueue,
  RunWorkerTask,
  runJobId,
} from '../../src/modules/playbooks/adapters/queue/run-queue.js';
import { testRedisUrl } from '../support/db.js';
import { createHarness, type Harness } from './playbooks-harness.js';

/**
 * The playbook executor on real BullMQ/Redis (ADR-0008): jobs carry only `{ runId }`,
 * follow-up jobs are scheduled from the engine's outcome, and the startup reconciler
 * rebuilds the queue from Postgres after Redis loses it.
 */

const prefix = `spine-test-${randomBytes(4).toString('hex')}`;
let h: Harness;
let queue: BullMqRunQueue;
let worker: RunWorkerTask;
let redis: Redis;
let workerRedis: Redis;

beforeAll(async () => {
  redis = createRedis(testRedisUrl());
  workerRedis = createRedis(testRedisUrl());
  queue = new BullMqRunQueue(redis, prefix);
  h = await createHarness({ queue });
  worker = new RunWorkerTask({
    connection: workerRedis,
    concurrency: 2,
    logger: pino({ level: 'silent' }),
    advance: (runId, signal) => h.pb.executor.advanceRun(runId, signal),
    prefix,
  });
  worker.start();
});

afterAll(async () => {
  await worker.stop();
  await queue.bullQueue.obliterate({ force: true });
  await queue.close();
  await h.destroy();
  await redis.quit();
  await workerRedis.quit();
});

const status = async (runId: string) => (await h.pb.runs.summary(runId)).status;

describe('playbook executor on BullMQ', () => {
  it('runs an automatic playbook end to end: alert.scored → outbox → queue → worker', async () => {
    const snapshot = h.alert({ category: 'phishing' });
    await h.publish('alert.scored', snapshot.alert.id, {
      alert: snapshot.alert,
      enrichments: snapshot.enrichments,
      score: snapshot.score!,
    });
    await h.drainOutbox();
    const [run] = await h.pb.runs.forAlert(snapshot.alert.id);
    await expect.poll(() => status(run!.id), { timeout: 15_000 }).toBe('succeeded');
    const chat = await h.t.db
      .selectFrom('simulated_actions')
      .select('kind')
      .where('run_id', '=', run!.id)
      .execute();
    expect(chat.map((c) => c.kind)).toEqual(['chat.post']);
  });

  it('parks a run at an approval and resumes it when the decision re-enqueues it', async () => {
    const snapshot = h.alert({ category: 'malware', score: 95 });
    const [runId] = await h.pb.runs.triggerForScoredAlert(snapshot);
    await queue.enqueue(runId!, 1);
    await expect.poll(() => status(runId!), { timeout: 15_000 }).toBe('waiting_approval');
    const pending = await h.pb.approvals.list({ status: 'pending', limit: 10 });
    const approval = pending.items.find((a) => a.runId === runId)!;
    await h.pb.approvals.decide(
      approval.id,
      { decision: 'approve' },
      { id: '0190f0a0-0000-7000-8000-00000000000b', role: 'analyst' },
    );
    await expect.poll(() => status(runId!), { timeout: 15_000 }).toBe('succeeded');
  });

  it('reconciler: after Redis loses its jobs, every resumable run is re-enqueued (and only those)', async () => {
    await worker.stop();
    const pendingRun = (
      await h.pb.runs.triggerForScoredAlert(h.alert({ category: 'phishing' }))
    )[0]!;
    const runningRun = (
      await h.pb.runs.triggerForScoredAlert(h.alert({ category: 'phishing' }))
    )[0]!;
    await h.pb.store.runs.append(runningRun, 1, [
      {
        seq: 2,
        type: 'step.started',
        stepId: 'enrich',
        payload: { attempt: 1, idempotencyKey: `${runningRun}:enrich:1` },
        occurredAt: h.clock.now().toISOString(),
      },
    ]);
    const waitingRun = (
      await h.pb.runs.triggerForScoredAlert(h.alert({ category: 'credential_access', score: 90 }))
    )[0]!;
    await h.pb.executor.advanceRun(waitingRun);
    expect(await status(waitingRun)).toBe('waiting_approval');

    await queue.bullQueue.obliterate({ force: true }); // Redis was wiped
    const count = await h.pb.executor.reconcile();

    expect(count).toBe(2);
    expect(await queue.bullQueue.getJob(runJobId(pendingRun, 1))).toBeDefined();
    expect(await queue.bullQueue.getJob(runJobId(runningRun, 2))).toBeDefined();
    const jobs = await queue.bullQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.map((j) => j.data.runId).sort()).toEqual([pendingRun, runningRun].sort());
  });
});
