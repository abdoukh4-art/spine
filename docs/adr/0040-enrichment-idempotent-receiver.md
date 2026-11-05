# ADR-0040: The enrichment handler is an idempotent receiver keyed by event id

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** enrichment + scoring workstream
- **Tags:** architecture, data

## Context and problem statement

Events are delivered **at least once** ([ADR-0009](0009-domain-events-transactional-outbox.md)):
the relay can crash after enqueueing but before marking a row dispatched, and BullMQ retries a
job whose worker died. So `enrichment.on-alert-ingested` will sometimes see the same
`alert.ingested` event twice, and occasionally twice **at the same time** on two workers.

The handler's writes are naturally idempotent (upserts on `(alert, provider, indicator)`).
Its side effect isn't: each run publishes an `alert.enriched` event. A redelivery would
publish a second one, which triggers a second scoring run, a second `alert.scored`, and a
second round of playbook trigger matching. Downstream handlers must be idempotent anyway,
but every duplicate also costs provider calls (real quotas, in a real deployment) and adds
noise to the event log that people debug with.

We had to choose: prevent the duplicate `alert.enriched`, or accept it and make scoring
absorb it.

## Decision drivers

- Correct under concurrent redelivery, not only sequential redelivery.
- No duplicate events when nothing changed. The event log should mean something.
- Don't hold a database transaction open while waiting on providers.
- Simple enough to explain in one paragraph.

## Considered options

1. **Inbox table**: `enrichment_processed_events(event_id PK)`, inserted in the same
   transaction as the upserts and the outbox insert.
2. **Mark rows with the source event id**: a `source_event_id` column on
   `alert_enrichments`; skip if rows with that id exist.
3. **Accept duplicates**: always publish, and rely on scoring being idempotent.
4. **Lock per alert**: `SELECT … FOR UPDATE` on some per-alert row, or an advisory lock,
   for the whole handler.

## Decision outcome

**Chosen option 1, the inbox table.** The handler runs in two phases:

1. **Pre-check (no transaction):** if `event_id` is already in the inbox, return. This is
   the cheap path for sequential redeliveries and saves the provider calls.
2. **Lookups (no transaction):** call the providers through their resilience stacks.
3. **One transaction:** `INSERT INTO enrichment_processed_events … ON CONFLICT DO NOTHING
RETURNING event_id`. No row back means a concurrent delivery already committed: write
   nothing and return. Otherwise upsert the results, read back the merged set and publish
   `alert.enriched`. Then commit.

Two deliveries racing past the pre-check both do the lookups (wasted, but harmless), then
serialize on the inbox primary key: the second `INSERT` waits for the first transaction
and then conflicts. Exactly one `alert.enriched` is published. The integration test
`enrichment.test.ts › is idempotent` fires three concurrent deliveries of one event. We
also checked that it catches the bug: with the guard disabled, it fails.

`POST /alerts/:id/enrich` (a deliberate re-run) has no source event and skips the inbox.
It always publishes, because the analyst asked for fresh data.

### Consequences

- 👍 Exactly one `alert.enriched` per `alert.ingested`, even under concurrent redelivery.
- 👍 The lookups run outside the transaction, so no connection sits idle in a transaction
  while a provider times out.
- 👍 The inbox doubles as an audit trail: "when was this event processed?"
- 👎 One more table, which grows by one row per ingested alert. It needs a retention job
  eventually (rows older than the BullMQ completed-job retention, 24 h, can never be
  needed again). Not implemented in v0.1, see "revisit".
- 👎 A racing duplicate still pays for its lookups. Acceptable: races are rare.

## Pros and cons of the options

### Mark rows with the source event id

- 👍 No new table.
- 👎 An alert with **no indicators and no host** produces zero rows, yet must still
  publish `alert.enriched` (scoring needs to run). There would be nothing to mark, so
  that case would publish duplicates again.
- 👎 Re-enrichment overwrites the rows, which loses the marker.

### Accept duplicates

- 👍 Zero code.
- 👎 Duplicate provider calls and duplicate downstream events. Scoring's change detection
  ([ADR-0042](0042-scoring-publish-only-on-change.md)) would swallow most of them, but
  "it's fine because the next module copes" spreads the cost across every consumer.

### Lock per alert

- 👍 Serializes everything about one alert.
- 👎 The lock would be held across provider calls (seconds), or would need a separate
  "claim" step. It also doesn't remember that the event was handled: a sequential
  redelivery would run again.

## What would make us revisit this

- The inbox grows past ~10 M rows → add a daily purge of rows older than 7 days.
- More modules need the same pattern → extract a platform-level `Inbox` port (one table
  keyed by `(subscriber, event_id)`), and migrate this table into it.

## Further reading

- Gregor Hohpe & Bobby Woolf, _Enterprise Integration Patterns_, "Idempotent Receiver"
- Chris Richardson, _Microservices Patterns_, ch. 3.3 "Handling duplicate messages"
