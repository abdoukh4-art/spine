import { advance, type AdvanceResult, type StepHandlers } from '@spine/playbook-engine';
import type { Logger } from '../../../platform/logger.js';
import type { Clock } from '../../../platform/runtime.js';
import type { ExecutionObserver, RunQueue, RunRepository } from './ports.js';

/** Dependencies of {@link RunExecutor}. */
export interface RunExecutorDeps {
  runs: RunRepository;
  handlers: StepHandlers;
  queue: RunQueue;
  clock: Clock;
  observer: ExecutionObserver;
  logger: Logger;
  maxIterations?: number;
}

/**
 * Hosts the engine's executor (ADR-0010, ADR-0051): one queue job = one `advance` call.
 * When the engine stops early it tells us when to come back, and we schedule that as a
 * new job; the queue only ever carries `{ runId }`, never state.
 */
export class RunExecutor {
  constructor(private readonly deps: RunExecutorDeps) {}

  /** Advances one run and schedules the follow-up job the outcome asks for. */
  async advanceRun(runId: string, signal?: AbortSignal): Promise<AdvanceResult> {
    const result = await advance(runId, {
      store: this.deps.runs,
      handlers: this.deps.handlers,
      clock: this.deps.clock,
      ...(signal ? { signal } : {}),
      ...(this.deps.maxIterations ? { maxIterations: this.deps.maxIterations } : {}),
      hooks: {
        onStepFinished: (info) => {
          this.deps.observer.stepFinished({
            type: info.type,
            status: info.status,
            durationMs: info.durationMs,
          });
        },
      },
    });
    const { outcome } = result;
    if (outcome.kind === 'retry_scheduled') {
      await this.deps.queue.enqueue(runId, result.lastSeq, {
        delayMs: outcome.delayMs,
        notBefore: outcome.notBefore,
      });
    } else if (outcome.kind === 'yielded') {
      await this.deps.queue.enqueue(runId, result.lastSeq);
    }
    this.deps.logger.debug({ runId, outcome, iterations: result.iterations }, 'run advanced');
    return result;
  }

  /**
   * Startup reconciler: Redis is not the source of truth (ADR-0008), so after a restart
   * (or a wiped Redis) every run that should be progressing gets a job again. Duplicate
   * job IDs make this harmless when the jobs still exist.
   * @returns how many runs were re-enqueued
   */
  async reconcile(): Promise<number> {
    const runs = await this.deps.runs.resumable();
    for (const run of runs) await this.deps.queue.enqueue(run.id, run.lastSeq);
    return runs.length;
  }
}
