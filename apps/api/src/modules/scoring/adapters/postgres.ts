import { ScoreExplanationSchema, type ScoreExplanation } from '@spine/shared-schema';
import { sql } from 'kysely';
import type { Db } from '../../../platform/db/database.js';
import type { DbExecutor, EventPublisher } from '../../../platform/events/types.js';
import type { ScoreRepository, ScoringTransaction } from '../application/ports.js';

/** Postgres adapter for `alert_scores` (owned by the scoring module, ADR-0002). */
export class PostgresScoreRepository implements ScoreRepository {
  constructor(
    private readonly db: Db,
    private readonly events: EventPublisher,
  ) {}

  transaction<T>(work: (tx: ScoringTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => work(this.bind(trx)));
  }

  async latestForAlert(alertId: string): Promise<ScoreExplanation | null> {
    const row = await this.db
      .selectFrom('alert_scores')
      .select('explanation')
      .where('alert_id', '=', alertId)
      .orderBy('computed_at', 'desc')
      .orderBy('ruleset_version', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? ScoreExplanationSchema.parse(row.explanation) : null;
  }

  private bind(trx: DbExecutor): ScoringTransaction {
    return {
      saveIfChanged: (alertId, explanation, sourceOccurredAt) =>
        saveIfChanged(trx, alertId, explanation, sourceOccurredAt),
      publish: async (events) => {
        await this.events.publish(trx, events);
      },
    };
  }
}

/**
 * Decides "insert, update or nothing" atomically (ADR-0042):
 *
 * 1. `INSERT … ON CONFLICT DO NOTHING RETURNING`: a first score for (alert, version) is new.
 * 2. Otherwise lock the row (`FOR UPDATE`), so a concurrent duplicate delivery waits here.
 * 3. An older snapshot than the stored one is ignored (out-of-order delivery).
 * 4. A newer-or-equal snapshot always advances `source_occurred_at`; the explanation is
 *    replaced, and `alert.scored` published, only if it differs from the stored one
 *    ignoring `computedAt` (compared as jsonb, so key order doesn't matter).
 *
 * Advancing the timestamp even when nothing else changed matters: otherwise an identical
 * newer snapshot would leave the old time in place, and a stale snapshot arriving after it
 * could overwrite the score.
 */
async function saveIfChanged(
  trx: DbExecutor,
  alertId: string,
  explanation: ScoreExplanation,
  sourceOccurredAt: Date,
): Promise<boolean> {
  const values = {
    alert_id: alertId,
    ruleset_version: explanation.rulesetVersion,
    score: explanation.score,
    severity: explanation.severity,
    explanation: JSON.stringify(explanation),
    computed_at: explanation.computedAt,
    source_occurred_at: sourceOccurredAt,
  };
  const inserted = await trx
    .insertInto('alert_scores')
    .values(values)
    .onConflict((oc) => oc.columns(['alert_id', 'ruleset_version']).doNothing())
    .returning('alert_id')
    .executeTakeFirst();
  if (inserted) return true;

  const current = await trx
    .selectFrom('alert_scores')
    .select([
      'source_occurred_at',
      sql<boolean>`(explanation - 'computedAt') = (${values.explanation}::jsonb - 'computedAt')`.as(
        'same',
      ),
    ])
    .where('alert_id', '=', alertId)
    .where('ruleset_version', '=', explanation.rulesetVersion)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (sourceOccurredAt.getTime() < toMillis(current.source_occurred_at)) return false;

  const changed = !current.same;
  await trx
    .updateTable('alert_scores')
    .set(changed ? values : { source_occurred_at: sourceOccurredAt })
    .where('alert_id', '=', alertId)
    .where('ruleset_version', '=', explanation.rulesetVersion)
    .execute();
  return changed;
}

/** node-postgres turns `-infinity` (the column default) into the number -Infinity, not a Date. */
function toMillis(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}
