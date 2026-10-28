import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createSocGaugesTask } from '../../../src/modules/metrics/adapters/gauges.js';
import { ManualClock } from '../../../src/platform/runtime.js';

describe('SOC gauges task', () => {
  const clock = new ManualClock('2026-10-28T12:00:00Z');

  it('computes rolling 24 h values on start and stops cleanly', async () => {
    const task = createSocGaugesTask(
      {
        alertsReceivedBetween: (w) => {
          expect(w.to.getTime() - w.from.getTime()).toBe(24 * 3_600_000);
          return Promise.resolve([
            {
              occurredAt: new Date('2026-10-28T11:00:00Z'),
              receivedAt: new Date('2026-10-28T11:01:00Z'),
              resolvedAt: new Date('2026-10-28T11:11:00Z'),
              severity: 'medium',
            },
          ]);
        },
        runsBetween: () =>
          Promise.resolve([
            {
              status: 'succeeded',
              dryRun: false,
              startedAt: new Date(),
              finishedAt: new Date(),
              approvalWaitMs: 0,
            },
          ]),
      },
      clock,
      pino({ level: 'silent' }),
    );
    await task.start();
    expect(task.values()).toEqual({ mttd: 60, mttr: 600, successRate: 1, open: 0 });
    await task.stop();
  });

  it('keeps serving the last values and logs when the read model fails', async () => {
    const logger = pino({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const task = createSocGaugesTask(
      {
        alertsReceivedBetween: () => Promise.reject(new Error('db down')),
        runsBetween: () => Promise.resolve([]),
      },
      clock,
      logger,
    );
    await task.start();
    expect(Number.isNaN(task.values().mttd)).toBe(true);
    expect(warn).toHaveBeenCalled();
    await task.stop();
  });
});
