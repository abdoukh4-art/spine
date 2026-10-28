import type { Db } from '../../../../platform/db/database.js';
import type { EventPublisher } from '../../../../platform/events/types.js';
import type {
  PlaybooksStore,
  PlaybooksUnitOfWork,
  SimulatedActionReader,
} from '../../application/ports.js';
import type { DomainEventDraft } from '../../domain/run-view.js';
import { PostgresApprovalRepository } from './approval-repository.js';
import { PostgresPlaybookRepository } from './playbook-repository.js';
import { PostgresRunRepository, type RunFinishedListener } from './run-repository.js';
import type { Executor } from './shared.js';

/**
 * Postgres implementation of the module's persistence ports. Repositories are bound to an
 * executor: the root pool (auto-commit) or a transaction (a unit of work), so a use case can
 * group "lock approval + append run event + publish domain event" into one commit.
 */
export class PostgresPlaybooksStore implements PlaybooksStore {
  readonly playbooks: PostgresPlaybookRepository;
  readonly runs: PostgresRunRepository;
  readonly approvals: PostgresApprovalRepository;

  constructor(
    private readonly db: Db,
    private readonly events: EventPublisher,
    readonly simulatedActions: SimulatedActionReader,
    private readonly listener: RunFinishedListener | null = null,
  ) {
    const uow = this.bind(db);
    this.playbooks = uow.playbooks;
    this.runs = uow.runs;
    this.approvals = uow.approvals;
  }

  async publish(drafts: readonly DomainEventDraft[]): Promise<void> {
    if (drafts.length > 0) await this.events.publish(this.db, drafts);
  }

  transaction<T>(fn: (uow: PlaybooksUnitOfWork) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => fn(this.bind(trx)));
  }

  private bind(executor: Executor): {
    playbooks: PostgresPlaybookRepository;
    runs: PostgresRunRepository;
    approvals: PostgresApprovalRepository;
    publish: (drafts: readonly DomainEventDraft[]) => Promise<void>;
  } {
    return {
      playbooks: new PostgresPlaybookRepository(executor),
      runs: new PostgresRunRepository(executor, this.events, this.listener),
      approvals: new PostgresApprovalRepository(executor),
      publish: async (drafts) => {
        if (drafts.length > 0) await this.events.publish(executor, drafts);
      },
    };
  }
}
