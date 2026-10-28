import type { Alert, CanonicalAlert, IngestResult } from '@spine/shared-schema';
import { ConflictError, IdempotencyKeyReusedError } from '../../../platform/errors.js';
import type { DbExecutor, EventPublisher } from '../../../platform/events/types.js';
import type { Clock, IdGenerator } from '../../../platform/runtime.js';
import { OpenAlertExistsError, type AlertsPublicApi } from '../../alerts/public-api.js';
import { idempotencyExpiry } from '../domain/idempotency.js';
import { prepareAlert } from '../domain/prepare-alert.js';
import type { IdempotencyStore, TransactionRunner } from './ports.js';

/** What the HTTP adapter asks for. `alert` has already passed a normalizer. */
export interface IngestCommand {
  alert: CanonicalAlert;
  /** Present when the client sent an `Idempotency-Key` header. */
  idempotency?: { scope: string; key: string; requestHash: Buffer };
}

export type IngestOutcome =
  /** Processed now. */
  | { kind: 'fresh'; status: 202; result: IngestResult }
  /** Same key + same body as an earlier request: its stored response, replayed. */
  | { kind: 'replay'; status: number; result: IngestResult };

/** Dependencies of {@link IngestAlert}. */
export interface IngestAlertDeps {
  alerts: AlertsPublicApi;
  events: EventPublisher;
  tx: TransactionRunner;
  idempotency: IdempotencyStore;
  clock: Clock;
  ids: IdGenerator;
  /** How many times to retry after losing a race (default 5). */
  maxAttempts?: number;
}

/** Internal signal: a concurrent transaction won a race; start over and observe its result. */
class LostRace extends Error {}

/**
 * The ingestion use case (ADR-0012, ADR-0033):
 *
 *     prepare (indicators, raw cap, fingerprint)  — pure, outside the transaction
 *     BEGIN
 *       idempotency record for (scope, key)?  → replay it (same body) or 409 (different body)
 *       open alert with this fingerprint?      → duplicate_count+1, last_seen_at, alert.deduplicated
 *       otherwise                              → INSERT alert, alert.ingested (full snapshot)
 *       store the idempotency record
 *     COMMIT
 *
 * Races: two transactions may both see "no open alert" and both INSERT. The partial unique
 * index lets only one commit; the loser gets {@link OpenAlertExistsError}, its transaction
 * rolls back, and we run the whole unit again, which now finds the winner's alert and records
 * a duplicate. The same retry covers two requests racing on one Idempotency-Key.
 */
export class IngestAlert {
  private readonly maxAttempts: number;

  constructor(private readonly deps: IngestAlertDeps) {
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  /** Ingests one normalized alert. @throws IdempotencyKeyReusedError, ConflictError. */
  async execute(command: IngestCommand): Promise<IngestOutcome> {
    const prepared = prepareAlert(command.alert);
    const receivedAt = this.deps.clock.now();
    const newId = this.deps.ids.next();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.deps.tx.run((trx) =>
          this.attempt(trx, command, prepared.alert, prepared.fingerprint, receivedAt, newId),
        );
      } catch (error) {
        const retryable = error instanceof OpenAlertExistsError || error instanceof LostRace;
        if (!retryable) throw error;
        if (attempt >= this.maxAttempts) {
          throw new ConflictError('the alert is being ingested concurrently; retry the request');
        }
      }
    }
  }

  private async attempt(
    trx: DbExecutor,
    command: IngestCommand,
    canonical: CanonicalAlert,
    fingerprint: string,
    receivedAt: Date,
    newId: string,
  ): Promise<IngestOutcome> {
    const idem = command.idempotency;
    if (idem) {
      const stored = await this.deps.idempotency.find(
        trx,
        idem.scope,
        idem.key,
        idempotencyExpiry(receivedAt),
      );
      if (stored) {
        if (!stored.requestHash.equals(idem.requestHash)) throw new IdempotencyKeyReusedError();
        return { kind: 'replay', status: stored.status, result: stored.body };
      }
    }
    const result = await this.dedupOrCreate(trx, canonical, fingerprint, receivedAt, newId);
    if (idem) {
      const saved = await this.deps.idempotency.save(
        trx,
        {
          scope: idem.scope,
          key: idem.key,
          response: { requestHash: idem.requestHash, status: 202, body: result },
          createdAt: receivedAt,
        },
        idempotencyExpiry(receivedAt),
      );
      if (!saved) throw new LostRace();
    }
    return { kind: 'fresh', status: 202, result };
  }

  private async dedupOrCreate(
    trx: DbExecutor,
    canonical: CanonicalAlert,
    fingerprint: string,
    receivedAt: Date,
    newId: string,
  ): Promise<IngestResult> {
    const at = receivedAt.toISOString();
    const open = await this.deps.alerts.findOpenByFingerprint(trx, fingerprint);
    if (open) {
      const dup = await this.deps.alerts.recordDuplicate(trx, open.alertId, at);
      await this.deps.events.publish(trx, [
        {
          type: 'alert.deduplicated',
          aggregateId: open.alertId,
          payload: { alertId: open.alertId, fingerprint, ...dup },
        },
      ]);
      return { alertId: open.alertId, status: 'deduplicated', duplicateOf: open.alertId };
    }
    const alert: Alert = {
      ...canonical,
      id: newId,
      fingerprint,
      status: 'new',
      receivedAt: at,
      lastSeenAt: at,
      duplicateCount: 0,
    };
    await this.deps.alerts.create(trx, alert);
    await this.deps.events.publish(trx, [
      { type: 'alert.ingested', aggregateId: alert.id, payload: { alert } },
    ]);
    return { alertId: alert.id, status: 'created' };
  }
}
