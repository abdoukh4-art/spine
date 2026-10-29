import { ConcurrencyError, reduce } from '@spine/playbook-engine';
import type { Approval, ApprovalDecision, ApprovalStatus, Page, Role } from '@spine/shared-schema';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../platform/errors.js';
import type { Logger } from '../../../platform/logger.js';
import type { Clock } from '../../../platform/runtime.js';
import { decisionProblem, timeoutOutcome } from '../domain/approval.js';
import type { PlaybooksStore, PlaybooksUnitOfWork, RunQueue } from './ports.js';
import { CONCURRENCY_RETRIES } from './runs.js';

/** Dependencies of {@link ApprovalService}. */
export interface ApprovalServiceDeps {
  store: PlaybooksStore;
  queue: RunQueue;
  clock: Clock;
  logger: Logger;
}

/** Who is deciding. */
export interface Decider {
  id: string;
  role: Role;
  requestId?: string;
}

/**
 * Approval use cases (human-in-the-loop). A decision is ONE transaction: lock the approval
 * row, check the rules, mark it decided, and append `approval.granted|rejected` to the
 * run's log, and write the audit entry. Then the run is re-enqueued so the executor continues.
 */
export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  list(filter: {
    status?: ApprovalStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<Approval>> {
    return this.deps.store.approvals.list(filter);
  }

  /**
   * Records an analyst's decision.
   * @throws NotFoundError | ConflictError (already decided or expired) | ForbiddenError
   */
  async decide(approvalId: string, input: ApprovalDecision, actor: Decider): Promise<Approval> {
    for (let attempt = 1; attempt <= CONCURRENCY_RETRIES; attempt += 1) {
      try {
        const { approval, seq } = await this.deps.store.transaction((uow) =>
          this.decideInTransaction(uow, approvalId, input, actor),
        );
        await this.enqueueQuietly(approval.runId, seq);
        return approval;
      } catch (err) {
        if (!(err instanceof ConcurrencyError)) throw err;
      }
    }
    throw new ConflictError('the run is changing too quickly; retry the decision');
  }

  private async decideInTransaction(
    uow: PlaybooksUnitOfWork,
    approvalId: string,
    input: ApprovalDecision,
    actor: Decider,
  ): Promise<{ approval: Approval; seq: number }> {
    const approval = await uow.approvals.getForUpdate(approvalId);
    if (!approval) throw new NotFoundError('Approval', approvalId);
    const now = this.deps.clock.now();
    const startedBy = await uow.runs.startedBy(approval.runId);
    const problem = decisionProblem(approval, actor, now, startedBy);
    if (problem?.kind === 'already_decided') {
      throw new ConflictError(`approval is already ${problem.status}`);
    }
    if (problem?.kind === 'expired') throw new ConflictError('approval has expired');
    if (problem?.kind === 'insufficient_role') {
      throw new ForbiddenError(`this approval requires role ${problem.required}`);
    }
    if (problem?.kind === 'self_approval') {
      throw new ForbiddenError('four-eyes rule: the person who started this run cannot approve it');
    }
    const approved = input.decision === 'approve';
    const decided = await uow.approvals.markDecided(approvalId, {
      status: approved ? 'approved' : 'rejected',
      decidedBy: actor.id,
      comment: input.comment ?? null,
      at: now.toISOString(),
    });
    const seq = await this.appendDecision(uow, approval, {
      type: approved ? 'approval.granted' : 'approval.rejected',
      payload: {
        approvalId,
        decidedBy: actor.id,
        comment: input.comment ?? null,
        reason: 'decision',
      },
      at: now.toISOString(),
    });
    // Audited in the same transaction: a decision without its audit entry cannot exist.
    await uow.audit({
      actorId: actor.id,
      actorType: 'user',
      action: 'approval.decided',
      targetType: 'approval',
      targetId: approvalId,
      ...(actor.requestId ? { requestId: actor.requestId } : {}),
      details: { decision: input.decision, runId: approval.runId, stepId: approval.stepId },
    });
    return { approval: decided, seq };
  }

  /** Appends the decision event; returns its seq. Conflicts propagate to retry the whole decision. */
  private async appendDecision(
    uow: PlaybooksUnitOfWork,
    approval: Approval,
    decision: {
      type: 'approval.granted' | 'approval.rejected';
      payload: Record<string, unknown>;
      at: string;
    },
  ): Promise<number> {
    const loaded = await uow.runs.load(approval.runId);
    if (!loaded) throw new NotFoundError('Run', approval.runId);
    const state = reduce(loaded.definition, loaded.events);
    if (state.pendingApproval?.approvalId !== approval.id) {
      throw new ConflictError('the run is no longer waiting for this approval');
    }
    const seq = state.lastSeq + 1;
    await uow.runs.append(approval.runId, state.lastSeq, [
      {
        seq,
        type: decision.type,
        stepId: approval.stepId,
        payload: decision.payload,
        occurredAt: decision.at,
      },
    ]);
    return seq;
  }

  /**
   * Applies `onTimeout` to every pending approval past its deadline: the approval becomes
   * `expired` and the run receives `approval.granted` or `approval.rejected` with
   * `reason: timeout`. Each approval is handled in its own transaction.
   * @returns the number of approvals expired
   */
  async expireDue(limit = 100): Promise<number> {
    const now = this.deps.clock.now().toISOString();
    const due = await this.deps.store.approvals.dueForExpiry(now, limit);
    let expired = 0;
    for (const approvalId of due) {
      try {
        const seq = await this.deps.store.transaction((uow) =>
          this.expireOne(uow, approvalId, now),
        );
        if (seq === null) continue;
        expired += 1;
        const approval = await this.deps.store.approvals.get(approvalId);
        if (approval) await this.enqueueQuietly(approval.runId, seq);
      } catch (err) {
        this.deps.logger.error({ err, approvalId }, 'failed to expire approval');
      }
    }
    return expired;
  }

  private async expireOne(
    uow: PlaybooksUnitOfWork,
    approvalId: string,
    now: string,
  ): Promise<number | null> {
    const approval = await uow.approvals.getForUpdate(approvalId);
    if (approval?.status !== 'pending' || Date.parse(approval.expiresAt) > Date.parse(now)) {
      return null;
    }
    const loaded = await uow.runs.load(approval.runId);
    const step = loaded?.definition.steps.find((s) => s.id === approval.stepId);
    const onTimeout = step?.type === 'approval' ? step.with.onTimeout : 'reject';
    await uow.approvals.markDecided(approvalId, {
      status: 'expired',
      decidedBy: null,
      comment: `no decision before the deadline; onTimeout=${onTimeout}`,
      at: now,
    });
    const state = loaded ? reduce(loaded.definition, loaded.events) : null;
    if (state?.pendingApproval?.approvalId !== approvalId) return null;
    return this.appendDecision(uow, approval, {
      type: timeoutOutcome(onTimeout),
      payload: { approvalId, decidedBy: null, comment: null, reason: 'timeout' },
      at: now,
    });
  }

  private async enqueueQuietly(runId: string, seq: number): Promise<void> {
    try {
      await this.deps.queue.enqueue(runId, seq);
    } catch (err) {
      this.deps.logger.warn({ err, runId }, 'direct enqueue failed; relying on the outbox');
    }
  }
}
