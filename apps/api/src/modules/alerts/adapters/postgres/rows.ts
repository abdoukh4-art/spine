import type {
  Alert,
  AlertCategory,
  AlertSummary,
  CanonicalAlert,
  MitreMapping,
  Severity,
} from '@spine/shared-schema';
import type { Selectable } from 'kysely';
import type { AlertsTable, CasesTable } from '../../../../platform/db/schema.js';
import type { CaseRecord } from '../../application/ports.js';

/**
 * Row ↔ domain mapping for the Alerts/Cases tables. The `canonical` jsonb column holds the
 * canonical fields (what the source said); lifecycle fields (status, counters, timestamps
 * assigned by Spine) live in real columns so they can be indexed and updated in place.
 */

/** Columns needed for an {@link AlertSummary} (deliberately NOT the whole `canonical`, which may hold 64 KiB of raw payload). */
export const SUMMARY_COLUMNS = [
  'id',
  'title',
  'category',
  'status',
  'source_severity',
  'severity',
  'score',
  'source_vendor',
  'source_product',
  'occurred_at',
  'received_at',
  'last_seen_at',
  'duplicate_count',
  'assignee_id',
  'case_id',
  'resolved_at',
] as const;

export type SummaryRow = Pick<Selectable<AlertsTable>, (typeof SUMMARY_COLUMNS)[number]> & {
  mitre: MitreMapping[] | null;
};

/** ISO-8601 string of a timestamp column. */
export function iso(value: Date): string {
  return value.toISOString();
}

/** Nullable variant of {@link iso}. */
export function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Maps a summary row. */
export function toSummary(row: SummaryRow): AlertSummary {
  return {
    id: row.id,
    title: row.title,
    category: row.category as AlertCategory,
    status: row.status,
    sourceSeverity: row.source_severity as Severity,
    severity: row.severity as Severity | null,
    score: row.score,
    source: { vendor: row.source_vendor, product: row.source_product },
    occurredAt: iso(row.occurred_at),
    receivedAt: iso(row.received_at),
    lastSeenAt: iso(row.last_seen_at),
    duplicateCount: row.duplicate_count,
    assigneeId: row.assignee_id,
    caseId: row.case_id,
    mitre: row.mitre ?? [],
    resolvedAt: isoOrNull(row.resolved_at),
  };
}

/** Rebuilds the full {@link Alert} from the stored canonical fields + lifecycle columns. */
export function toAlert(
  row: Pick<
    Selectable<AlertsTable>,
    | 'id'
    | 'fingerprint'
    | 'status'
    | 'received_at'
    | 'last_seen_at'
    | 'duplicate_count'
    | 'canonical'
  >,
): Alert {
  const canonical = row.canonical as CanonicalAlert;
  return {
    ...canonical,
    id: row.id,
    fingerprint: row.fingerprint,
    status: row.status,
    receivedAt: iso(row.received_at),
    lastSeenAt: iso(row.last_seen_at),
    duplicateCount: row.duplicate_count,
  };
}

/** Splits an {@link Alert} into its canonical part (what goes into the jsonb column). */
export function canonicalPart(alert: Alert): CanonicalAlert {
  const {
    id: _id,
    fingerprint: _fp,
    status: _status,
    receivedAt: _received,
    lastSeenAt: _lastSeen,
    duplicateCount: _dup,
    ...canonical
  } = alert;
  return canonical;
}

/** Maps a `cases` row. */
export function toCaseRecord(row: Selectable<CasesTable>): CaseRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** True when `error` is a Postgres unique violation on the named constraint/index. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}
