# ADR-0009: Cross-module domain events via a transactional outbox

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture, data

## Context and problem statement

The alert pipeline crosses several bounded contexts:

```
Ingestion ──alert.ingested──▶ Enrichment ──alert.enriched──▶ Scoring ──alert.scored──▶ Playbooks
                    └────────▶ Alerts (projection)                         └──────────▶ Alerts (projection)
```

If Ingestion wrote the alert and then *directly called* Enrichment, a crash between the two
steps would lose the enrichment forever. Publishing to a queue *after* the DB commit has
the same "dual write" problem: the commit succeeds, the publish fails, and the event is lost.
Publishing *before* the commit can emit an event for data that then rolls back.

## Decision drivers

- No lost events and no phantom events.
- Modules stay decoupled: a publisher doesn't know its subscribers.
- Per-subscriber retries: a failing scoring handler must not re-run enrichment.
- Simple enough to teach.

## Considered options

1. **Transactional outbox in Postgres + relay → BullMQ fan-out (one job per subscriber)**
2. In-process synchronous event emitter (`EventEmitter`)
3. Publish directly to BullMQ after commit
4. Postgres `LISTEN/NOTIFY`
5. Change Data Capture (Debezium) from the WAL

## Decision outcome

**Chosen option 1.**

1. A use case writes its state change **and** inserts rows into `domain_events` in the
   **same transaction** (`EventPublisher.publish(trx, events)`).
2. The **outbox relay** (in the worker process) polls
   `SELECT … FROM domain_events WHERE dispatched_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`,
   and for every registered subscriber of that event type enqueues a BullMQ job on
   `spine.events` with `jobId = "<eventId>:<subscriberName>"` (deduplicated by BullMQ).
   Then it sets `dispatched_at`.
3. Workers run the subscriber's handler. Handlers are **idempotent**: they check
   whether they already processed `eventId`, or they make naturally idempotent upserts.
4. Events are versioned (`type`, `version`) and their payload schemas live in
   `@spine/shared-schema/events` ([event catalog](../architecture/event-catalog.md)).

In unit and integration tests, an `InMemoryEventBus` adapter implements the same port and
dispatches synchronously, so module tests don't need Redis.

### Consequences

- 👍 **At-least-once** delivery with no dual-write gap. Crash-safe at every point.
- 👍 Subscribers fail and retry independently. Failures are visible as BullMQ failed jobs.
- 👎 Eventual consistency: the console may show an alert a few hundred ms before its score.
  The UI shows "enriching…/scoring…" states instead of hiding this.
- 👎 Polling latency (default 200 ms) and some DB load. Acceptable at our scale.
- 👎 Handlers must be idempotent. That is documented in every module's invariants.

## Pros and cons of the options

### In-process EventEmitter
- 👍 Trivial.
- 👎 Events are lost on a crash, there's no retry, and one slow handler blocks the request.

### Publish after commit
- 👍 Simple.
- 👎 The classic dual-write bug: a crash between commit and publish loses the event.

### LISTEN/NOTIFY
- 👍 Low latency.
- 👎 Notifications are not persisted, so missed while disconnected. Still needs an outbox table underneath.

### Debezium CDC
- 👍 Zero polling, and the canonical enterprise answer.
- 👎 Kafka + Kafka Connect cluster: massive operational overhead for this project.

## What would make us revisit this

- Outbox polling exceeds ~5 % of DB CPU → switch to LISTEN/NOTIFY wake-ups plus polling as a fallback.
- Multiple deployables need the events → introduce a real broker and keep the outbox as the producer.

## Further reading

- Chris Richardson, *Pattern: Transactional outbox* (microservices.io)
- Gregor Hohpe & Bobby Woolf, *Enterprise Integration Patterns*, "Idempotent Receiver"
