import { mkdtemp, writeFile, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DomainEvent } from '@spine/shared-schema';
import type { Worker } from 'bullmq';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MigrationChecksumError,
  migrate,
  migrationsUpToDate,
} from '../../src/platform/db/migrator.js';
import { InlineDeliveryQueue } from '../../src/platform/events/in-memory.js';
import { OutboxEventPublisher, OutboxRelay } from '../../src/platform/events/outbox.js';
import { EventSubscriptions } from '../../src/platform/events/types.js';
import {
  BullMqDeliveryQueue,
  createRedis,
  startEventWorker,
} from '../../src/platform/queue/bullmq.js';
import { ManualClock, SequentialIdGenerator, uuidV7Generator } from '../../src/platform/runtime.js';
import {
  createTestDatabase,
  MIGRATIONS_DIR,
  testRedisUrl,
  type TestDatabase,
} from '../support/db.js';

const logger = pino({ level: 'silent' });
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

function dedupEvent(alertId: string) {
  return {
    type: 'alert.deduplicated' as const,
    aggregateId: alertId,
    payload: {
      alertId,
      fingerprint: 'f'.repeat(64),
      duplicateCount: 1,
      lastSeenAt: '2026-10-28T10:00:00.000Z',
    },
  };
}

describe('migrator', () => {
  it('applies every migration once and reports up to date', async () => {
    const again = await migrate(t.db, MIGRATIONS_DIR);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied.length).toBe(
      (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).length,
    );
    expect(await migrationsUpToDate(t.db, MIGRATIONS_DIR)).toBe(true);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spine-mig-'));
    const scratch = await createTestDatabase({ migrate: false });
    try {
      await writeFile(path.join(dir, '0001_x_init.sql'), 'create table x (id int);');
      expect((await migrate(scratch.db, dir)).applied).toEqual(['0001_x_init.sql']);
      await writeFile(path.join(dir, '0001_x_init.sql'), 'create table x (id bigint);');
      await expect(migrate(scratch.db, dir)).rejects.toBeInstanceOf(MigrationChecksumError);
    } finally {
      await scratch.destroy();
    }
  });

  it('rolls back a failing migration atomically', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spine-mig-'));
    const scratch = await createTestDatabase({ migrate: false });
    try {
      await copyFile(
        path.join(MIGRATIONS_DIR, '0001_platform_init.sql'),
        path.join(dir, '0001_platform_init.sql'),
      );
      await writeFile(path.join(dir, '0002_broken.sql'), 'create table y (id int); select 1/0;');
      await expect(migrate(scratch.db, dir)).rejects.toThrow();
      const tables = await sql<{
        n: string;
      }>`select count(*)::text as n from information_schema.tables where table_schema = ${scratch.schema} and table_name = 'y'`.execute(
        scratch.db,
      );
      expect(tables.rows[0]?.n).toBe('0');
      expect(await migrationsUpToDate(scratch.db, dir)).toBe(false);
    } finally {
      await scratch.destroy();
    }
  });

  it('enforces the append-only audit log at the database level', async () => {
    await t.db
      .insertInto('audit_log')
      .values({ actor_type: 'system', action: 'test.append' })
      .execute();
    await expect(
      t.db.updateTable('audit_log').set({ action: 'tampered' }).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(t.db.deleteFrom('audit_log').execute()).rejects.toThrow(/append-only/);
  });
});

describe('transactional outbox', () => {
  const clock = new ManualClock('2026-10-28T10:00:00Z');
  const publisher = new OutboxEventPublisher(
    new SequentialIdGenerator(),
    clock,
    () => '00-abc-def-01',
  );

  it('publishes events only when the surrounding transaction commits', async () => {
    const id = uuidV7Generator.next();
    await t.db
      .transaction()
      .execute(async (trx) => {
        await publisher.publish(trx, [dedupEvent(id)]);
        throw new Error('rollback');
      })
      .catch(() => undefined);
    const afterRollback = await t.db
      .selectFrom('domain_events')
      .selectAll()
      .where('aggregate_id', '=', id)
      .execute();
    expect(afterRollback).toHaveLength(0);

    await t.db.transaction().execute((trx) => publisher.publish(trx, [dedupEvent(id)]));
    const rows = await t.db
      .selectFrom('domain_events')
      .selectAll()
      .where('aggregate_id', '=', id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.traceparent).toBe('00-abc-def-01');
  });

  it('rejects payloads that do not match the event catalog', async () => {
    await expect(
      publisher.publish(t.db, [
        { type: 'alert.deduplicated', aggregateId: 'x', payload: { alertId: 'nope' } as never },
      ]),
    ).rejects.toThrow();
  });

  it('relays each event to every subscriber exactly once per delivery key', async () => {
    const received: string[] = [];
    const subs = new EventSubscriptions();
    for (const name of ['a', 'b']) {
      subs.register({
        name: `test-${name}`,
        eventType: 'alert.deduplicated',
        handle: (e) => Promise.resolve(void received.push(`${name}:${e.aggregateId}`)),
      });
    }
    const relay = new OutboxRelay(t.db, subs, new InlineDeliveryQueue(subs, logger), logger, {
      pollIntervalMs: 10,
      batchSize: 2,
    });
    const ids = [uuidV7Generator.next(), uuidV7Generator.next(), uuidV7Generator.next()];
    await publisher.publish(t.db, ids.map(dedupEvent));
    // Drain: 3 new events (+ 1 from the previous test) with batch size 2.
    let total = 0;
    for (let n = await relay.dispatchBatch(); n > 0; n = await relay.dispatchBatch()) total += n;
    expect(total).toBe(4);
    for (const id of ids) {
      expect(received).toContain(`a:${id}`);
      expect(received).toContain(`b:${id}`);
    }
    expect(await relay.backlog()).toBe(0);
  });
});

describe('BullMQ delivery', () => {
  it('delivers outbox events to subscribers through Redis, deduplicating redeliveries', async () => {
    const redis = createRedis(testRedisUrl());
    const queue = new BullMqDeliveryQueue(redis);
    await queue.queue.obliterate({ force: true });
    const handled: DomainEvent[] = [];
    const subs = new EventSubscriptions();
    subs.register({
      name: 'bullmq-test',
      eventType: 'alert.deduplicated',
      handle: (e) => Promise.resolve(void handled.push(e)),
    });
    const worker: Worker = startEventWorker({
      connection: createRedis(testRedisUrl()),
      subscriptions: subs,
      logger,
      concurrency: 2,
    });
    try {
      const id = uuidV7Generator.next();
      const event = {
        eventId: uuidV7Generator.next(),
        version: 1,
        occurredAt: '2026-10-28T10:00:00.000Z',
        ...dedupEvent(id),
      } as DomainEvent;
      // Enqueue the same delivery twice (simulating a relay crash before marking dispatched).
      await queue.enqueue([{ subscriber: 'bullmq-test', event }]);
      await queue.enqueue([{ subscriber: 'bullmq-test', event }]);
      await expect.poll(() => handled.length, { timeout: 10_000 }).toBe(1);
      await new Promise((r) => setTimeout(r, 300));
      expect(handled).toHaveLength(1);
      expect(handled[0]?.aggregateId).toBe(id);
    } finally {
      await worker.close();
      await queue.close();
      await redis.quit();
    }
  });
});
