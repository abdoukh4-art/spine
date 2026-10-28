import type { Db } from '../../../../platform/db/database.js';
import type { EventPublisher } from '../../../../platform/events/types.js';
import type {
  AuditEntry,
  AuditGateway,
  PlaybooksStore,
  PlaybooksUnitOfWork,
  SimulatedActionReader,
} from '../../application/ports.js';
import type { DomainEventDraft } from '../../domain/run-view.js';
import { PostgresApprovalRepository } from './approval-repository.js';
import { PostgresPlaybookRepository } from './playbook-repository.js';
import { PostgresRunRepository, type RunFinishedListener } from './run-repository.js';
import type { Executor } from './shared.js';

/** Collaborators of {@link PostgresPlaybooksStore}. */
export interface PlaybooksStoreDeps {
  db: Db;
  events: EventPublisher;
  audit: AuditGateway;
  simulatedActions: SimulatedActionReader;
  listener?: RunFinishedListener | null;
}

/**
 * Postgres implementation of the module's persistence ports. Repositories are bound to an
 * executor: the root pool (auto-commit) or a transaction (a unit of work), so a use case can
 * group "lock approval + append run event + publish domain event + audit" into one commit.
 */
export class PostgresPlaybooksStore implements PlaybooksStore {
  readonly playbooks: PostgresPlaybookRepository;
  readonly runs: PostgresRunRepository;
  readonly approvals: PostgresApprovalRepository;
  readonly simulatedActions: SimulatedActionReader;
  private readonly root: PlaybooksUnitOfWork;

  constructor(private readonly deps: PlaybooksStoreDeps) {
    const uow = this.bind(deps.db);
    this.root = uow;
    this.playbooks = uow.playbooks;
    this.runs = uow.runs;
    this.approvals = uow.approvals;
    this.simulatedActions = deps.simulatedActions;
  }

  publish(drafts: readonly DomainEventDraft[]): Promise<void> {
    return this.root.publish(drafts);
  }

  audit(entry: AuditEntry): Promise<void> {
    return this.root.audit(entry);
  }

  transaction<T>(fn: (uow: PlaybooksUnitOfWork) => Promise<T>): Promise<T> {
    return this.deps.db.transaction().execute((trx) => fn(this.bind(trx)));
  }

  private bind(executor: Executor): PlaybooksUnitOfWork & {
    playbooks: PostgresPlaybookRepository;
    runs: PostgresRunRepository;
    approvals: PostgresApprovalRepository;
  } {
    const { events, audit, listener } = this.deps;
    return {
      playbooks: new PostgresPlaybookRepository(executor),
      runs: new PostgresRunRepository(executor, events, listener ?? null),
      approvals: new PostgresApprovalRepository(executor),
      publish: async (drafts) => {
        if (drafts.length > 0) await events.publish(executor, drafts);
      },
      audit: (entry) => audit.record(entry, executor),
    };
  }
}
