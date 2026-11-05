import { randomUUID } from 'node:crypto';
import { SEVERITIES, type RunStatus } from '@spine/shared-schema';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertStatsReceivedBetween } from '../../src/modules/alerts/adapters/postgres/reporting-queries.js';
import {
  aggregateAlerts,
  aggregateRuns,
  type AlertTimes,
  type RunTimes,
} from '../../src/modules/metrics/domain/soc-metrics.js';
import { runStatsBetween } from '../../src/modules/playbooks/adapters/postgres/reporting-queries.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';

/**
 * Differential test (ADR-0095): the SQL aggregates must equal the Metrics module's TypeScript
 * formulas (the executable specification of ADR-0026) on random data. Timestamps are at
 * millisecond precision, like everything Spine stores. Means may differ by one rounding step:
 * Postgres averages exact numerics and rounds a tie (x.xxx5) up, while the TypeScript double is
 * often a hair below the tie and rounds down. So means are compared to within 1 ms (+ float noise);
 * counts and percentiles (observed values) must be identical.
 */

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await sql`insert into playbooks (id, version, name, definition, source)
            values ('p', 1, 'p', '{}'::jsonb, '')`.execute(t.db);
});
afterAll(async () => t.destroy());

const WINDOW = {
  from: new Date('2026-10-20T00:00:00.000Z'),
  to: new Date('2026-10-27T00:00:00.000Z'),
};
const ms = (d: Date) => d.getTime();
const date = (min: number, max: number) => fc.integer({ min, max }).map((n) => new Date(n));

const alertArb = fc
  .record({
    // Received inside, or just outside, the window (the query must filter by received_at).
    receivedAt: date(ms(WINDOW.from) - 86_400_000, ms(WINDOW.to) + 86_400_000),
    // Occurred up to 2 h before or 10 min after (clock skew) receipt.
    detectMs: fc.integer({ min: -600_000, max: 7_200_000 }),
    closed: fc.constantFrom('resolved', 'false_positive', null),
    resolveMs: fc.integer({ min: -60_000, max: 3 * 86_400_000 }),
    severity: fc.option(fc.constantFrom(...SEVERITIES), { nil: null }),
    sourceSeverity: fc.constantFrom(...SEVERITIES),
    // An open alert may still carry a resolved_at from before a reopen (ADR-0036).
    staleResolvedAt: fc.boolean(),
  })
  .map((a) => ({
    ...a,
    occurredAt: new Date(ms(a.receivedAt) - a.detectMs),
    resolvedAt:
      a.closed !== null || a.staleResolvedAt ? new Date(ms(a.receivedAt) + a.resolveMs) : null,
  }));

const RUN_STATUSES: RunStatus[] = [
  'pending',
  'running',
  'waiting_approval',
  'compensating',
  'succeeded',
  'failed',
  'compensated',
  'cancelled',
];
const runArb = fc
  .record({
    status: fc.constantFrom(...RUN_STATUSES),
    dryRun: fc.boolean(),
    finishedAt: date(ms(WINDOW.from) - 86_400_000, ms(WINDOW.to) + 86_400_000),
    durationMs: fc.integer({ min: 0, max: 3_600_000 }),
    approvalWaitMs: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 4_000_000 })),
    hasStarted: fc.boolean(),
  })
  .map((r) => {
    const terminal = !['pending', 'running', 'waiting_approval', 'compensating'].includes(r.status);
    return {
      ...r,
      startedAt: r.hasStarted || terminal ? new Date(ms(r.finishedAt) - r.durationMs) : null,
      finishedAt: terminal ? r.finishedAt : null,
    };
  });

function expectStatClose(
  actual: {
    count: number;
    meanSeconds: number | null;
    p50Seconds: number | null;
    p90Seconds: number | null;
  },
  expected: typeof actual,
) {
  expect(actual.count).toBe(expected.count);
  expect(actual.p50Seconds).toBe(expected.p50Seconds);
  expect(actual.p90Seconds).toBe(expected.p90Seconds);
  if (expected.meanSeconds === null) expect(actual.meanSeconds).toBeNull();
  else
    expect(Math.abs((actual.meanSeconds ?? NaN) - expected.meanSeconds)).toBeLessThanOrEqual(
      0.001 + 1e-9,
    );
}

describe('metrics SQL aggregates = TypeScript specification', () => {
  it('alerts: volume, MTTD and MTTR', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(alertArb, { maxLength: 40 }), async (alerts) => {
        await sql`delete from alerts`.execute(t.db);
        for (const a of alerts) {
          await sql`
            insert into alerts (id, fingerprint, status, title, category, source_vendor,
                                source_product, source_severity, severity, occurred_at,
                                received_at, last_seen_at, resolved_at, canonical)
            values (${randomUUID()}, ${randomUUID()}, ${a.closed ?? 'triaged'}, 't', 'other', 'v',
                    'p', ${a.sourceSeverity}, ${a.severity}, ${a.occurredAt}, ${a.receivedAt},
                    ${a.receivedAt}, ${a.resolvedAt}, '{}'::jsonb)`.execute(t.db);
        }
        // What the old row-based read model handed to the specification.
        const inWindow: AlertTimes[] = alerts
          .filter((a) => a.receivedAt >= WINDOW.from && a.receivedAt < WINDOW.to)
          .map((a) => ({
            occurredAt: a.occurredAt,
            receivedAt: a.receivedAt,
            resolvedAt: a.closed !== null ? a.resolvedAt : null,
            severity: a.severity ?? a.sourceSeverity,
          }));
        const expected = aggregateAlerts(inWindow);
        const actual = await alertStatsReceivedBetween(t.db, WINDOW.from, WINDOW.to);

        expect(actual.total).toBe(expected.total);
        const bySeverity = (rows: { severity: string; count: number }[]) =>
          Object.fromEntries(rows.map((r) => [r.severity, r.count]));
        expect(bySeverity(actual.bySeverity)).toEqual(bySeverity(expected.bySeverity));
        expect(actual.byDay).toEqual(expected.byDay);
        expectStatClose(actual.mttd, expected.mttd);
        expect(actual.mttd.clockSkewCount).toBe(expected.mttd.clockSkewCount);
        expectStatClose(actual.mttr, expected.mttr);
        expect(actual.mttr.openCount).toBe(expected.mttr.openCount);
      }),
      { numRuns: 60 },
    );
  });

  it('playbook runs: outcome counts, latency and approval wait', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(runArb, { maxLength: 40 }), async (runs) => {
        await sql`delete from playbook_runs`.execute(t.db);
        for (const r of runs) {
          await sql`
            insert into playbook_runs (id, playbook_id, playbook_version, alert_id, dry_run, status,
                                       trigger, started_at, finished_at, approval_wait_ms)
            values (${randomUUID()}, 'p', 1, ${randomUUID()}, ${r.dryRun}, ${r.status}, 'manual',
                    ${r.startedAt}, ${r.finishedAt}, ${r.approvalWaitMs})`.execute(t.db);
        }
        const inFlight = ['pending', 'running', 'waiting_approval', 'compensating'];
        const selected: RunTimes[] = runs
          .filter(
            (r) =>
              (r.finishedAt !== null && r.finishedAt >= WINDOW.from && r.finishedAt < WINDOW.to) ||
              inFlight.includes(r.status),
          )
          .map((r) => ({
            status: r.status,
            dryRun: r.dryRun,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            approvalWaitMs: r.approvalWaitMs,
          }));
        const expected = aggregateRuns(selected);
        const actual = await runStatsBetween(t.db, WINDOW.from, WINDOW.to);

        expect({ ...actual, latency: null, approvalWait: null }).toEqual({
          ...expected,
          latency: null,
          approvalWait: null,
        });
        expectStatClose(actual.latency, expected.latency);
        expectStatClose(actual.approvalWait, expected.approvalWait);
      }),
      { numRuns: 60 },
    );
  });
});
