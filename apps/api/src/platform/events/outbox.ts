import { parseEventPayload, type DomainEvent } from '@spine/shared-schema';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';
import type { Logger } from '../logger.js';
import type { Clock, IdGenerator } from '../runtime.js';
import type { DbExecutor, EventPublisher, EventSubscriptions, NewDomainEvent } from './types.js';

/** Returns the current W3C traceparent, if tracing is active (wired by telemetry). */
export type TraceparentProvider = () => string | undefined;

/**
 * Outbox adapter for {@link EventPublisher}: inserts events into `domain_events` using the
 * caller's executor, so they commit (or roll back) atomically with the state change.
 */
export class OutboxEventPublisher implements EventPublisher {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly traceparent: TraceparentProvider = () => undefined,
  ) {}

  async publish(executor: DbExecutor, events: readonly NewDomainEvent[]): Promise<DomainEvent[]> {
    if (events.length === 0) return [];
    const now = this.clock.now();
    const traceparent = this.traceparent();
    const built: DomainEvent[] = events.map((e) => {
      // Validate at publish time: a malformed event is a programming error, caught in tests.
      const payload = parseEventPayload(e.type, e.payload);
      return {
        eventId: this.ids.next(),
        type: e.type,
        version: e.version ?? 1,
        aggregateId: e.aggregateId,
        occurredAt: now.toISOString(),
        payload,
        ...(traceparent ? { traceparent } : {}),
      } as DomainEvent;
    });
    await executor
      .insertInto('domain_events')
      .values(
        built.map((e) => ({
          event_id: e.eventId,
          type: e.type,
          version: e.version,
          aggregate_id: e.aggregateId,
          payload: JSON.stringify(e.payload),
          traceparent: e.traceparent ?? null,
          occurred_at: e.occurredAt,
        })),
      )
      .execute();
    return built;
  }
}

/**
 * Number of events not yet dispatched by the relay. Ingestion uses it for back-pressure
 * (ADR-0024): a growing backlog means the pipeline is behind, so stop accepting more work.
 */
export async function outboxBacklog(db: Db): Promise<number> {
  const row = await db
    .selectFrom('domain_events')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('dispatched_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** One delivery = one event for one subscriber. */
export interface EventDelivery {
  subscriber: string;
  event: DomainEvent;
}

/** Port: hands deliveries to the async transport (BullMQ in production). */
export interface DeliveryQueue {
  /** Must be idempotent per (event.eventId, subscriber). */
  enqueue(deliveries: readonly EventDelivery[]): Promise<void>;
}

/**
 * Polls undispatched outbox rows and fans each out to every subscriber of its type.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so several relays can run concurrently without double
 * work. If enqueue succeeds but the UPDATE's commit fails, the rows are re-dispatched on
 * the next poll; the queue's per-delivery job IDs make that harmless (at-least-once).
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;

  constructor(
    private readonly db: Db,
    private readonly subscriptions: EventSubscriptions,
    private readonly queue: DeliveryQueue,
    private readonly logger: Logger,
    private readonly options: { pollIntervalMs: number; batchSize: number },
  ) {}

  /** Dispatches one batch. Returns the number of events dispatched. */
  async dispatchBatch(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('domain_events')
        .selectAll()
        .where('dispatched_at', 'is', null)
        .orderBy('id')
        .limit(this.options.batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return 0;

      const deliveries: EventDelivery[] = [];
      for (const row of rows) {
        const event = {
          eventId: row.event_id,
          type: row.type,
          version: row.version,
          aggregateId: row.aggregate_id,
          occurredAt: row.occurred_at.toISOString(),
          payload: row.payload,
          ...(row.traceparent ? { traceparent: row.traceparent } : {}),
        } as DomainEvent;
        for (const handler of this.subscriptions.handlersFor(event.type)) {
          deliveries.push({ subscriber: handler.name, event });
        }
      }
      await this.queue.enqueue(deliveries);
      await trx
        .updateTable('domain_events')
        .set({ dispatched_at: sql<Date>`now()`, attempts: sql<number>`attempts + 1` })
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
      return rows.length;
    });
  }

  /** Number of events waiting to be dispatched (used for back-pressure, ADR-0024). */
  backlog(): Promise<number> {
    return outboxBacklog(this.db);
  }

  /** Starts polling. Drains in a tight loop while batches are full, then sleeps. */
  start(): void {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      this.running = true;
      let delay = this.options.pollIntervalMs;
      try {
        const n = await this.dispatchBatch();
        if (n === this.options.batchSize) delay = 0;
      } catch (err) {
        this.logger.error({ err }, 'outbox relay batch failed');
      } finally {
        this.running = false;
      }
      // stop() may have run while we awaited the batch; TS can't see that mutation.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.stopped) this.timer = setTimeout(() => void tick(), delay);
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  /** Stops polling and waits for an in-flight batch to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }
}
