import {
  EnrichmentDataSchema,
  FAILED_ENRICHMENT_STATUSES,
  type EnrichmentResult,
  type EnrichmentStatus,
  type IndicatorType,
  type Verdict,
} from '@spine/shared-schema';
import { sql, type Selectable } from 'kysely';
import type { Db } from '../../../platform/db/database.js';
import type { AlertEnrichmentsTable } from '../../../platform/db/schema.js';
import type { DbExecutor, EventPublisher } from '../../../platform/events/types.js';
import type { EnrichmentRepository, EnrichmentTransaction } from '../application/ports.js';

const FAILED = sql.join(FAILED_ENRICHMENT_STATUSES.map((s) => sql.lit(s)));

/**
 * Postgres adapter for the enrichment module's tables: `alert_enrichments` and
 * `enrichment_processed_events`. No other module's table is touched (ADR-0002).
 */
export class PostgresEnrichmentRepository implements EnrichmentRepository {
  constructor(
    private readonly db: Db,
    private readonly events: EventPublisher,
  ) {}

  /** Runs `work` in one transaction; events published through it commit atomically with the writes. */
  transaction<T>(work: (tx: EnrichmentTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => work(this.bind(trx)));
  }

  listForAlert(alertId: string): Promise<EnrichmentResult[]> {
    return listForAlert(this.db, alertId);
  }

  async wasProcessed(eventId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('enrichment_processed_events')
      .select('event_id')
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    return row !== undefined;
  }

  private bind(trx: DbExecutor): EnrichmentTransaction {
    return {
      markProcessed: async (eventId, alertId, at) => {
        const inserted = await trx
          .insertInto('enrichment_processed_events')
          .values({ event_id: eventId, alert_id: alertId, processed_at: at })
          .onConflict((oc) => oc.column('event_id').doNothing())
          .returning('event_id')
          .executeTakeFirst();
        return inserted !== undefined;
      },
      upsertResults: (alertId, results) => upsertResults(trx, alertId, results),
      listForAlert: (alertId) => listForAlert(trx, alertId),
      publish: async (events) => {
        await this.events.publish(trx, events);
      },
    };
  }
}

/**
 * One row per (alert, provider, indicator). On conflict, the new result wins only if it is
 * at least as recent AND it is not a failure replacing a success (ADR-0041): stale-but-real
 * data is more useful to an analyst than a fresh "timeout".
 */
async function upsertResults(
  trx: DbExecutor,
  alertId: string,
  results: readonly EnrichmentResult[],
): Promise<void> {
  if (results.length === 0) return;
  // Two rows with the same key in one INSERT make Postgres fail with "ON CONFLICT DO UPDATE
  // command cannot affect row a second time". The service never produces such duplicates
  // (it de-duplicates targets), but a caller might: keep the last one.
  const unique = new Map(
    results.map((r) => [`${r.provider}\u0000${r.indicator.type}\u0000${r.indicator.value}`, r]),
  );
  await trx
    .insertInto('alert_enrichments')
    .values([...unique.values()].map((r) => toRow(alertId, r)))
    .onConflict((oc) =>
      oc
        .columns(['alert_id', 'provider', 'indicator_type', 'indicator_value'])
        .doUpdateSet((eb) => ({
          status: eb.ref('excluded.status'),
          verdict: eb.ref('excluded.verdict'),
          data: eb.ref('excluded.data'),
          error: eb.ref('excluded.error'),
          duration_ms: eb.ref('excluded.duration_ms'),
          fetched_at: eb.ref('excluded.fetched_at'),
        }))
        .where(sql<boolean>`excluded.fetched_at >= alert_enrichments.fetched_at`)
        .where(
          sql<boolean>`(excluded.status not in (${FAILED}) or alert_enrichments.status in (${FAILED}))`,
        ),
    )
    .execute();
}

async function listForAlert(executor: DbExecutor, alertId: string): Promise<EnrichmentResult[]> {
  const rows = await executor
    .selectFrom('alert_enrichments')
    .selectAll()
    .where('alert_id', '=', alertId)
    .orderBy('indicator_type')
    .orderBy('indicator_value')
    .orderBy('provider')
    .execute();
  return rows.map(fromRow);
}

/** Maps a result to an `alert_enrichments` row (jsonb is written as a JSON string). */
function toRow(alertId: string, r: EnrichmentResult) {
  return {
    alert_id: alertId,
    provider: r.provider,
    indicator_type: r.indicator.type,
    indicator_value: r.indicator.value,
    status: r.status,
    verdict: r.verdict ?? null,
    data: r.data === undefined ? null : JSON.stringify(r.data),
    error: r.error ?? null,
    duration_ms: r.durationMs,
    fetched_at: r.fetchedAt,
  };
}

function fromRow(row: Selectable<AlertEnrichmentsTable>): EnrichmentResult {
  const data = row.data === null ? undefined : EnrichmentDataSchema.safeParse(row.data);
  return {
    provider: row.provider,
    indicator: { type: row.indicator_type as IndicatorType, value: row.indicator_value },
    status: row.status as EnrichmentStatus,
    ...(row.verdict === null ? {} : { verdict: row.verdict as Verdict }),
    ...(data?.success ? { data: data.data } : {}),
    ...(row.error === null ? {} : { error: row.error }),
    durationMs: row.duration_ms,
    fetchedAt: row.fetched_at.toISOString(),
  };
}
