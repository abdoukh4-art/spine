import type {
  Case,
  CaseDetail,
  CaseListQuery,
  CreateCaseRequest,
  Page,
  UpdateCaseRequest,
} from '@spine/shared-schema';
import { NotFoundError, UnprocessableError } from '../../../platform/errors.js';
import type { DbExecutor } from '../../../platform/events/types.js';
import type { Clock, IdGenerator } from '../../../platform/runtime.js';
import type { AlertRepository, CaseRecord, CaseRepository, TransactionRunner } from './ports.js';

/** Dependencies of {@link CasesService}. */
export interface CasesServiceDeps {
  alerts: AlertRepository;
  cases: CaseRepository;
  tx: TransactionRunner;
  clock: Clock;
  ids: IdGenerator;
  db: DbExecutor;
}

/**
 * Cases group related alerts into one investigation. Deliberately thin CRUD (ADR-0002:
 * "hexagonal is a tool, not a religion"): the link lives on `alerts.case_id`, so an alert
 * belongs to at most one case, and linking it to another case moves it.
 */
export class CasesService {
  constructor(private readonly deps: CasesServiceDeps) {}

  /** Creates a case and links the given alerts. @throws UnprocessableError for unknown alert ids. */
  async create(request: CreateCaseRequest, actorId: string | null): Promise<Case> {
    const at = this.deps.clock.now().toISOString();
    const record: CaseRecord = {
      id: this.deps.ids.next(),
      title: request.title,
      description: request.description ?? null,
      status: 'open',
      createdBy: actorId,
      createdAt: at,
      updatedAt: at,
    };
    return this.deps.tx.run(async (trx) => {
      await this.deps.cases.insert(trx, record);
      await this.link(trx, record.id, request.alertIds, at);
      return this.withAlertIds(trx, record);
    });
  }

  /** Updates fields and links/unlinks alerts. @throws NotFoundError, UnprocessableError. */
  async update(caseId: string, request: UpdateCaseRequest): Promise<Case> {
    const at = this.deps.clock.now().toISOString();
    return this.deps.tx.run(async (trx) => {
      const existing = await this.deps.cases.get(trx, caseId, { lock: true });
      if (!existing) throw new NotFoundError('Case', caseId);
      await this.deps.cases.update(trx, caseId, {
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.status !== undefined ? { status: request.status } : {}),
        updatedAt: at,
      });
      if (request.removeAlertIds?.length) {
        await this.deps.alerts.setCase(trx, request.removeAlertIds, null, at, caseId);
      }
      await this.link(trx, caseId, request.addAlertIds ?? [], at);
      const updated = await this.deps.cases.get(trx, caseId);
      if (!updated) throw new NotFoundError('Case', caseId);
      return this.withAlertIds(trx, updated);
    });
  }

  /** Case + summaries of its alerts. @throws NotFoundError. */
  async get(caseId: string): Promise<CaseDetail> {
    const record = await this.deps.cases.get(this.deps.db, caseId);
    if (!record) throw new NotFoundError('Case', caseId);
    const alerts = await this.deps.alerts.summariesForCase(this.deps.db, caseId);
    return { ...record, alertIds: alerts.map((a) => a.id), alerts };
  }

  /** Cases, newest first, with keyset pagination. */
  async list(query: CaseListQuery): Promise<Page<Case>> {
    const page = await this.deps.cases.list(query);
    const ids = await this.deps.alerts.alertIdsByCase(
      this.deps.db,
      page.items.map((c) => c.id),
    );
    return {
      items: page.items.map((c) => ({ ...c, alertIds: ids.get(c.id) ?? [] })),
      nextCursor: page.nextCursor,
    };
  }

  private async link(
    trx: DbExecutor,
    caseId: string,
    alertIds: readonly string[],
    at: string,
  ): Promise<void> {
    if (alertIds.length === 0) return;
    const unique = [...new Set(alertIds)];
    const existing = new Set(await this.deps.alerts.existingIds(trx, unique));
    const missing = unique.filter((id) => !existing.has(id));
    if (missing.length > 0) {
      throw new UnprocessableError(
        'some alerts do not exist',
        missing.slice(0, 20).map((id) => ({ path: 'alertIds', message: `unknown alert ${id}` })),
      );
    }
    await this.deps.alerts.setCase(trx, unique, caseId, at);
  }

  private async withAlertIds(executor: DbExecutor, record: CaseRecord): Promise<Case> {
    const ids = await this.deps.alerts.alertIdsByCase(executor, [record.id]);
    return { ...record, alertIds: ids.get(record.id) ?? [] };
  }
}
