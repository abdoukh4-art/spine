import path from 'node:path';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { PlaybookCatalog } from '../../../src/modules/playbooks/application/catalog.js';
import {
  ApprovalExpiryTask,
  PlaybookSeedTask,
  readPlaybookSources,
  RunReconcilerTask,
} from '../../../src/modules/playbooks/adapters/tasks.js';
import { runJobId } from '../../../src/modules/playbooks/adapters/queue/run-queue.js';

const logger = pino({ level: 'silent' });
const configDir = path.resolve(import.meta.dirname, '../../../config/playbooks');

describe('playbook background tasks', () => {
  it('reads playbook sources from a directory, and nothing from a missing one', async () => {
    const sources = await readPlaybookSources(configDir);
    expect(sources.map((s) => [s.name, s.format])).toEqual([
      ['brute-force-response.yaml', 'yaml'],
      ['malware-containment.yaml', 'yaml'],
      ['phishing-triage.yaml', 'yaml'],
    ]);
    expect(await readPlaybookSources(path.join(configDir, 'does-not-exist'))).toEqual([]);
  });

  it('seeds through the catalog on start', async () => {
    const seen: string[] = [];
    const catalog = {
      seed: (sources: { name: string }[]) => {
        seen.push(...sources.map((s) => s.name));
        return Promise.resolve({ inserted: ['x@1'], invalid: ['bad.yaml: nope'] });
      },
    } as unknown as PlaybookCatalog;
    const task = new PlaybookSeedTask(catalog, configDir, logger);
    await task.start();
    await task.stop();
    expect(seen).toHaveLength(3);
  });

  it('reconciles once on start', async () => {
    let calls = 0;
    const task = new RunReconcilerTask(() => Promise.resolve(++calls), logger);
    await task.start();
    await task.stop();
    expect(calls).toBe(1);
  });

  it('sweeps on start and on every interval, survives failures, and stops cleanly', async () => {
    let calls = 0;
    const task = new ApprovalExpiryTask(
      () => {
        calls += 1;
        return calls === 2 ? Promise.reject(new Error('db down')) : Promise.resolve(calls);
      },
      1000,
      logger,
    );
    vi.useFakeTimers();
    try {
      task.start();
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toBe(3); // at start, then at 1 s (fails, logged) and 2 s
      await task.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds deterministic BullMQ job ids without ":"', () => {
    expect(runJobId('r1', 3)).toBe('run__r1__3');
    expect(runJobId('r1', 3, { notBefore: '2026-10-28T10:00:00.000Z', scheduledAt: 42 })).toBe(
      `run__r1__3__${Date.parse('2026-10-28T10:00:00.000Z')}__42`,
    );
  });
});
