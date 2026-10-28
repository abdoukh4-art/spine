import {
  ConcurrencyError,
  isTerminal,
  reduce,
  type RunEventRecord,
  type RunSnapshot,
  type RunStartedPayload,
} from '@spine/playbook-engine';
import type { Page, PlaybookDefinition, RunDetail, RunSummary } from '@spine/shared-schema';
import { ConflictError, NotFoundError } from '../../../platform/errors.js';
import type { Logger } from '../../../platform/logger.js';
import type { Clock, IdGenerator } from '../../../platform/runtime.js';
import { toStepStates } from '../domain/run-view.js';
import { matchesTrigger } from '../domain/trigger.js';
import type {
  AuditGateway,
  AlertSnapshotGateway,
  PlaybooksStore,
  RunListFilter,
  RunQueue,
} from './ports.js';

/** How many times a use case retries after losing an optimistic-concurrency race. */
export const CONCURRENCY_RETRIES = 3;

/** Dependencies of {@link RunService}. */
export interface RunServiceDeps {
  store: PlaybooksStore;
  queue: RunQueue;
  snapshots: AlertSnapshotGateway;
  audit: AuditGateway;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
}

/**
 * Run use cases: start (automatically from `alert.scored`, or manually), cancel, and the
 * read side (list, detail, runs of an alert).
 *
 * Starting a run = one transaction that inserts the run row, its `run.started` event
 * (carrying the alert snapshot, so the run never reads another module's tables) and a
 * `playbook.run.requested` domain event. The outbox then reliably gets the run onto the
 * executor queue (ADR-0009); a direct enqueue after commit is only a latency shortcut.
 */
export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  /**
   * Starts every enabled playbook whose trigger matches the scored alert. Idempotent:
   * at most one automatic run per (playbook, alert), so redelivery creates nothing.
   * @returns the IDs of runs created by this call
   */
  async triggerForScoredAlert(snapshot: RunSnapshot): Promise<string[]> {
    const created: string[] = [];
    for (const definition of await this.deps.store.playbooks.enabledLatest()) {
      if (!matchesTrigger(definition, snapshot)) continue;
      const runId = await this.create(definition, snapshot, {
        dryRun: false,
        trigger: 'auto',
        startedBy: null,
      });
      if (runId) created.push(runId);
    }
    return created;
  }

  /** Starts a run on demand. @throws NotFoundError for an unknown playbook or alert. */
  async startManual(input: {
    playbookId: string;
    alertId: string;
    dryRun: boolean;
    actorId: string;
  }): Promise<string> {
    const record = await this.deps.store.playbooks.get(input.playbookId);
    if (!record) throw new NotFoundError('Playbook', input.playbookId);
    const snapshot = await this.deps.snapshots.get(input.alertId);
    if (!snapshot) throw new NotFoundError('Alert', input.alertId);
    const runId = await this.create(record.definition, snapshot, {
      dryRun: input.dryRun,
      trigger: 'manual',
      startedBy: input.actorId,
    });
    if (!runId) throw new ConflictError('the run could not be created');
    await this.enqueueQuietly(runId, 1);
    return runId;
  }

  private async create(
    definition: PlaybookDefinition,
    snapshot: RunSnapshot,
    options: { dryRun: boolean; trigger: 'auto' | 'manual'; startedBy: string | null },
  ): Promise<string | null> {
    const runId = this.deps.ids.next();
    const { id: playbookId, version: playbookVersion } = definition.metadata;
    const payload: RunStartedPayload = {
      playbookId,
      playbookVersion,
      alertId: snapshot.alert.id,
      ...options,
      ...snapshot,
    };
    const started: RunEventRecord = {
      seq: 1,
      type: 'run.started',
      stepId: null,
      payload: payload as unknown as Record<string, unknown>,
      occurredAt: this.deps.clock.now().toISOString(),
    };
    const inserted = await this.deps.store.transaction(async (uow) => {
      const ok = await uow.runs.create({
        id: runId,
        playbookId,
        playbookVersion,
        alertId: snapshot.alert.id,
        dryRun: options.dryRun,
        trigger: options.trigger,
        startedBy: options.startedBy,
        started,
      });
      if (ok) {
        await uow.publish([
          {
            type: 'playbook.run.requested',
            aggregateId: runId,
            payload: {
              runId,
              playbookId,
              version: playbookVersion,
              alertId: snapshot.alert.id,
              dryRun: options.dryRun,
              trigger: options.trigger,
            },
          },
        ]);
      }
      return ok;
    });
    return inserted ? runId : null;
  }

  /**
   * Cancels a run that has not finished. Completed steps are not compensated (see
   * ADR-0052); a pending approval is marked expired so it leaves the inbox.
   * @throws NotFoundError | ConflictError (already terminal, or persistently racing)
   */
  async cancel(runId: string, actor: { id: string; requestId?: string }): Promise<RunSummary> {
    for (let attempt = 1; attempt <= CONCURRENCY_RETRIES; attempt += 1) {
      const loaded = await this.deps.store.runs.load(runId);
      if (!loaded) throw new NotFoundError('Run', runId);
      const state = reduce(loaded.definition, loaded.events);
      if (isTerminal(state.status)) throw new ConflictError(`run is already ${state.status}`);
      const now = this.deps.clock.now().toISOString();
      try {
        await this.deps.store.transaction(async (uow) => {
          await uow.runs.append(runId, state.lastSeq, [
            {
              seq: state.lastSeq + 1,
              type: 'run.cancelled',
              stepId: null,
              payload: { cancelledBy: actor.id, previousStatus: state.status },
              occurredAt: now,
            },
          ]);
          await uow.approvals.expirePendingForRun(runId, now);
        });
      } catch (err) {
        if (err instanceof ConcurrencyError) continue;
        throw err;
      }
      await this.deps.audit.record({
        actorId: actor.id,
        actorType: 'user',
        action: 'playbook.run.cancelled',
        targetType: 'playbook_run',
        targetId: runId,
        ...(actor.requestId ? { requestId: actor.requestId } : {}),
      });
      return this.summary(runId);
    }
    throw new ConflictError('the run is changing too quickly to cancel; retry');
  }

  /** @throws NotFoundError */
  async summary(runId: string): Promise<RunSummary> {
    const summary = await this.deps.store.runs.summary(runId);
    if (!summary) throw new NotFoundError('Run', runId);
    return summary;
  }

  /** Summary + full event timeline + derived per-step state. @throws NotFoundError */
  async detail(runId: string): Promise<RunDetail> {
    const [summary, loaded] = await Promise.all([
      this.deps.store.runs.summary(runId),
      this.deps.store.runs.load(runId),
    ]);
    if (!summary || !loaded) throw new NotFoundError('Run', runId);
    const state = reduce(loaded.definition, loaded.events);
    return {
      ...summary,
      events: loaded.events.map((e) => ({ runId, ...e })),
      steps: toStepStates(loaded.definition, state),
    };
  }

  list(filter: RunListFilter): Promise<Page<RunSummary>> {
    return this.deps.store.runs.list(filter);
  }

  forAlert(alertId: string): Promise<RunSummary[]> {
    return this.deps.store.runs.forAlert(alertId);
  }

  /** Enqueues an executor job; failures are logged, the outbox path will still deliver. */
  async enqueueQuietly(runId: string, seq: number): Promise<void> {
    try {
      await this.deps.queue.enqueue(runId, seq);
    } catch (err) {
      this.deps.logger.warn({ err, runId }, 'direct enqueue failed; relying on the outbox');
    }
  }
}
