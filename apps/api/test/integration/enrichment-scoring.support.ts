import type { Alert, DomainEvent, EventType } from '@spine/shared-schema';
import { pino } from 'pino';
import type { Db } from '../../src/platform/db/database.js';
import { OutboxEventPublisher } from '../../src/platform/events/outbox.js';
import type { PlatformDeps } from '../../src/platform/module.js';
import { ManualClock, uuidV7Generator } from '../../src/platform/runtime.js';
import { testConfig } from '../support/config.js';

/** Real platform deps on a test database, with the transactional outbox publisher. */
export function integrationDeps(
  db: Db,
  overrides: Record<string, string> = {},
): PlatformDeps & { clock: ManualClock } {
  const clock = new ManualClock('2026-10-28T10:00:00Z');
  return {
    config: testConfig({ ENRICHMENT_LATENCY_MS: '0', ...overrides }),
    logger: pino({ level: 'silent' }),
    db,
    clock,
    ids: uuidV7Generator,
    events: new OutboxEventPublisher(uuidV7Generator, clock),
    redis: null,
  };
}

/** Domain events of one type for one aggregate, oldest first, as stored in the outbox. */
export async function outboxEvents<T extends EventType>(
  db: Db,
  type: T,
  aggregateId: string,
): Promise<DomainEvent<T>[]> {
  const rows = await db
    .selectFrom('domain_events')
    .selectAll()
    .where('type', '=', type)
    .where('aggregate_id', '=', aggregateId)
    .orderBy('id')
    .execute();
  return rows.map(
    (r) =>
      ({
        eventId: r.event_id,
        type: r.type,
        version: r.version,
        aggregateId: r.aggregate_id,
        occurredAt: r.occurred_at.toISOString(),
        payload: r.payload,
      }) as DomainEvent<T>,
  );
}

/** A fresh alert (new UUIDv7 id) that the mock providers know a lot about. */
export function knownBadAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: uuidV7Generator.next(),
    fingerprint: 'b'.repeat(64),
    status: 'new',
    source: { vendor: 'Example EDR', product: 'Sensor' },
    title: 'LSASS memory read by unsigned binary; beacon to known C2',
    category: 'credential_access',
    severity: 'high',
    occurredAt: '2026-10-28T09:58:00.000Z',
    receivedAt: '2026-10-28T10:00:00.000Z',
    lastSeenAt: '2026-10-28T10:00:00.000Z',
    duplicateCount: 0,
    host: { hostname: 'dc01.corp.example', ips: ['10.10.0.10'] },
    indicators: [
      { type: 'ipv4', value: '203.0.113.66' },
      { type: 'domain', value: 'update-check.test' },
    ],
    mitre: [
      { tacticId: 'TA0006', techniqueId: 'T1003.001' },
      { tacticId: 'TA0011', techniqueId: 'T1071.001' },
    ],
    labels: {},
    ...overrides,
  };
}

/** Builds an `alert.ingested` envelope as the outbox relay would deliver it. */
export function ingestedEvent(
  alert: Alert,
  eventId = uuidV7Generator.next(),
): DomainEvent<'alert.ingested'> {
  return {
    eventId,
    type: 'alert.ingested',
    version: 1,
    aggregateId: alert.id,
    occurredAt: '2026-10-28T10:00:00.000Z',
    payload: { alert },
  };
}
