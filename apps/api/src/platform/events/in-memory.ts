import { parseEventPayload, type DomainEvent } from '@spine/shared-schema';
import type { Logger } from '../logger.js';
import type { Clock, IdGenerator } from '../runtime.js';
import type { DeliveryQueue, EventDelivery } from './outbox.js';
import type { DbExecutor, EventPublisher, EventSubscriptions, NewDomainEvent } from './types.js';

/**
 * Test double for {@link EventPublisher}: records published events in memory without a
 * database. Use `published` to assert on what a use case emitted.
 */
export class RecordingEventPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];
  private n = 0;

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  publish(_executor: DbExecutor, events: readonly NewDomainEvent[]): Promise<DomainEvent[]> {
    const built = events.map((e) => {
      this.n += 1;
      return {
        eventId: `00000000-0000-7000-9000-${this.n.toString(16).padStart(12, '0')}`,
        type: e.type,
        version: e.version ?? 1,
        aggregateId: e.aggregateId,
        occurredAt: this.clock.now().toISOString(),
        payload: parseEventPayload(e.type, e.payload),
      } as DomainEvent;
    });
    this.published.push(...built);
    return Promise.resolve(built);
  }

  ofType<T extends DomainEvent['type']>(type: T): DomainEvent<T>[] {
    return this.published.filter((e): e is DomainEvent<T> => e.type === type);
  }
}

/**
 * {@link DeliveryQueue} that invokes handlers in-process, synchronously in enqueue order.
 * Used by integration tests to run the whole pipeline without Redis, and by the demo seeder.
 * Failures are logged and collected rather than retried.
 */
export class InlineDeliveryQueue implements DeliveryQueue {
  readonly failures: { delivery: EventDelivery; error: unknown }[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly subscriptions: EventSubscriptions,
    private readonly logger?: Logger,
  ) {}

  async enqueue(deliveries: readonly EventDelivery[]): Promise<void> {
    for (const delivery of deliveries) {
      const key = `${delivery.event.eventId}__${delivery.subscriber}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const handler = this.subscriptions.byHandlerName(delivery.subscriber);
      if (!handler) continue;
      try {
        await handler.handle(delivery.event);
      } catch (error) {
        this.failures.push({ delivery, error });
        this.logger?.error(
          { err: error, subscriber: delivery.subscriber },
          'inline delivery failed',
        );
      }
    }
  }
}

/** Convenience: an id generator + clock bundle for tests. */
export interface TestRuntime {
  ids: IdGenerator;
  clock: Clock;
}
