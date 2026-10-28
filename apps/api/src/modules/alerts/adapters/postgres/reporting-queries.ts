import type { Severity } from '@spine/shared-schema';
import type { DbExecutor as Db } from '../../../../platform/events/types.js';
import type { AlertTimesRow } from '../../public-api.js';

const CLOSED = new Set(['resolved', 'false_positive']);

/**
 * Reporting read model for the Metrics module (ADR-0026, ADR-0029): the lifecycle timestamps
 * of alerts received in `[from, to)`. `resolvedAt` is reported only while the alert is closed.
 * ADR-0036 keeps the first close time across a reopen, so a reopened alert counts as open.
 */
export async function alertTimesReceivedBetween(
  db: Db,
  from: Date,
  to: Date,
): Promise<AlertTimesRow[]> {
  const rows = await db
    .selectFrom('alerts')
    .select(['occurred_at', 'received_at', 'resolved_at', 'status', 'severity', 'source_severity'])
    .where('received_at', '>=', from)
    .where('received_at', '<', to)
    .execute();
  return rows.map((r) => ({
    occurredAt: r.occurred_at,
    receivedAt: r.received_at,
    resolvedAt: CLOSED.has(r.status) ? r.resolved_at : null,
    severity: (r.severity ?? r.source_severity) as Severity,
  }));
}
