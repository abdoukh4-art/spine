import type { DomainEvent, EventPayload, EventType } from '@spine/shared-schema';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

export type { DomainEvent, EventType, EventPayload } from '@spine/shared-schema';

/** An event a use case wants to publish; the publisher assigns id, timestamp and trace context. */
export interface NewDomainEvent<T extends EventType = EventType> {
  type: T;
  aggregateId: string;
  payload: EventPayload<T>;
  version?: number;
}

/** Any Kysely executor — the root instance or a transaction. */
export type DbExecutor = Kysely<Database>;

/**
 * Port: publish domain events **as part of the caller's transaction** (ADR-0009).
 * Pass the same `trx` you used for the state change; the events become visible
 * to subscribers only if that transaction commits.
 */
export interface EventPublisher {
  publish(executor: DbExecutor, events: readonly NewDomainEvent[]): Promise<DomainEvent[]>;
}

/**
 * A subscriber. `name` must be unique and stable — it is part of the delivery job ID,
 * so renaming a subscriber causes redelivery of in-flight events.
 * Handlers MUST be idempotent: delivery is at-least-once.
 */
export interface EventHandler<T extends EventType = EventType> {
  name: string;
  eventType: T;
  handle(event: DomainEvent<T>): Promise<void>;
}

/** Registry of subscribers, populated by modules at composition time. */
export class EventSubscriptions {
  private readonly byType = new Map<EventType, EventHandler[]>();
  private readonly byName = new Map<string, EventHandler>();

  register<T extends EventType>(handler: EventHandler<T>): void {
    if (this.byName.has(handler.name)) {
      throw new Error(`duplicate event subscriber name: ${handler.name}`);
    }
    const erased = handler as unknown as EventHandler;
    this.byName.set(handler.name, erased);
    const list = this.byType.get(handler.eventType) ?? [];
    list.push(erased);
    this.byType.set(handler.eventType, list);
  }

  handlersFor(type: EventType): readonly EventHandler[] {
    return this.byType.get(type) ?? [];
  }

  byHandlerName(name: string): EventHandler | undefined {
    return this.byName.get(name);
  }

  all(): readonly EventHandler[] {
    return [...this.byName.values()];
  }
}
