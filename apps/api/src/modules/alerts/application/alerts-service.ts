import type { AlertTimesRow } from '../public-api.js';
import type {
  Alert,
  AlertDetail,
  AlertListQuery,
  AlertStatus,
  AlertSummary,
  Page,
  UpdateAlertRequest,
} from '@spine/shared-schema';
import { ConflictError, NotFoundError, UnprocessableError } from '../../../platform/errors.js';
import type { DbExecutor, EventPublisher } from '../../../platform/events/types.js';
import type { Clock } from '../../../platform/runtime.js';
import { planStatusChange } from '../domain/status-change.js';
import type { AlertsPublicApi } from '../public-api.js';
import type {
  AlertDetailSources,
  AlertPatch,
  AlertRepository,
  CaseRepository,
  TransactionRunner,
} from './ports.js';

/** Dependencies of {@link AlertsService}. */
export interface AlertsServiceDeps {
  alerts: AlertRepository;
  cases: CaseRepository;
  tx: TransactionRunner;
  events: EventPublisher;
  clock: Clock;
  detailSources: AlertDetailSources;
  /** Root executor for reads outside a transaction. */
  db: DbExecutor;
}

/**
 * Use cases of the Alerts context: reads for the queue and detail views, triage updates,
 * and the ingestion-facing persistence methods of {@link AlertsPublicApi}.
 */
export class AlertsService implements AlertsPublicApi {
  constructor(private readonly deps: AlertsServiceDeps) {}

  /** {@inheritDoc AlertsPublicApi.get} */
  get(alertId: string): Promise<Alert | null> {
    return this.deps.alerts.getAlert(this.deps.db, alertId);
  }

  /** {@inheritDoc AlertsPublicApi.setStatus} */
  async setStatus(alertId: string, to: AlertStatus, actorId: string | null): Promise<void> {
    await this.update(alertId, { status: to }, actorId);
  }

  /** {@inheritDoc AlertsPublicApi.findOpenByFingerprint} */
  async findOpenByFingerprint(trx: DbExecutor, fingerprint: string) {
    const found = await this.deps.alerts.lockOpenByFingerprint(trx, fingerprint);
    return found ? { alertId: found.id, duplicateCount: found.duplicateCount } : null;
  }

  /** {@inheritDoc AlertsPublicApi.recordDuplicate} */
  recordDuplicate(trx: DbExecutor, alertId: string, seenAt: string) {
    return this.deps.alerts.recordDuplicate(trx, alertId, seenAt);
  }

  /** {@inheritDoc AlertsPublicApi.create} */
  create(trx: DbExecutor, alert: Alert): Promise<void> {
    return this.deps.alerts.insert(trx, alert);
  }

  /** Lists alerts with filters and keyset pagination (ADR-0024, ADR-0037). */
  /** Reporting read model for the Metrics module (ADR-0026). */
  timesReceivedBetween(from: Date, to: Date): Promise<AlertTimesRow[]> {
    return this.deps.alerts.timesReceivedBetween(from, to);
  }

  list(query: AlertListQuery): Promise<Page<AlertSummary>> {
    return this.deps.alerts.list(query);
  }

  /** Alert + data from other modules (enrichments, score, runs), fetched concurrently. */
  async detail(alertId: string): Promise<AlertDetail> {
    const [alert, summary] = await Promise.all([
      this.deps.alerts.getAlert(this.deps.db, alertId),
      this.deps.alerts.getSummary(this.deps.db, alertId),
    ]);
    if (!alert || !summary) throw new NotFoundError('Alert', alertId);
    const src = this.deps.detailSources;
    const [enrichments, score, runs] = await Promise.all([
      src.enrichmentsFor(alertId),
      src.scoreFor(alertId),
      src.runsFor(alertId),
    ]);
    return { summary, alert, enrichments, score, runs };
  }

  /**
   * Triage update (PATCH /alerts/:id): status, assignee and case link, in one transaction
   * with the `alert.status_changed` event. The row is locked first, so two analysts changing
   * the same alert at once are serialized and each transition is validated against fresh state.
   * @throws NotFoundError, ConflictError (illegal transition or reopen collision), UnprocessableError (unknown case).
   */
  async update(
    alertId: string,
    request: UpdateAlertRequest,
    actorId: string | null,
  ): Promise<AlertSummary> {
    const at = this.deps.clock.now().toISOString();
    return this.deps.tx.run(async (trx) => {
      const current = await this.deps.alerts.lock(trx, alertId);
      if (!current) throw new NotFoundError('Alert', alertId);
      const patch: AlertPatch = { updatedAt: at };
      if (request.assigneeId !== undefined) patch.assigneeId = request.assigneeId;
      if (request.caseId !== undefined) {
        if (request.caseId !== null && !(await this.deps.cases.get(trx, request.caseId))) {
          throw new UnprocessableError(`case ${request.caseId} does not exist`);
        }
        patch.caseId = request.caseId;
      }
      let changed: { from: AlertStatus; to: AlertStatus } | null = null;
      if (request.status !== undefined) {
        const plan = planStatusChange(current, request.status, at);
        if (plan.kind === 'illegal') {
          throw new ConflictError(`illegal status transition ${plan.from} → ${plan.to}`);
        }
        if (plan.kind === 'change') {
          patch.status = plan.to;
          patch.resolvedAt = plan.resolvedAt;
          changed = { from: plan.from, to: plan.to };
        }
      }
      await this.deps.alerts.update(trx, alertId, patch);
      if (changed) {
        await this.deps.events.publish(trx, [
          {
            type: 'alert.status_changed',
            aggregateId: alertId,
            payload: { alertId, from: changed.from, to: changed.to, actorId, at },
          },
        ]);
      }
      const summary = await this.deps.alerts.getSummary(trx, alertId);
      if (!summary) throw new NotFoundError('Alert', alertId);
      return summary;
    });
  }
}
