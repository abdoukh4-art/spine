# ADR-0033: One ingest transaction; retry the whole unit after losing a race

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** ingestion workstream
- **Tags:** data, architecture

## Context and problem statement

[ADR-0012](0012-idempotency-and-deduplication.md) defines _what_ deduplication and
idempotency mean. This ADR records _how_ they are made correct under concurrency, because the
naive version ("SELECT the open alert; if none, INSERT") is wrong when two copies arrive at
the same time: both SELECTs see nothing and both INSERT.

The same race exists for Idempotency-Keys: a client that times out and retries immediately
can have two requests with the same key in flight at once.

## Decision drivers

- At most one open alert per fingerprint, always (the database must guarantee it, not timing).
- A retried request must never double-count (`duplicate_count`) or double-emit events.
- The alert change, its outbox event and the idempotency record commit together or not at all
  ([ADR-0009](0009-domain-events-transactional-outbox.md)).
- Simple enough to teach.

## Considered options

1. **Unique partial index + run the whole transaction again on a unique violation**
2. `INSERT … ON CONFLICT (fingerprint) WHERE status NOT IN (…) DO NOTHING`, then SELECT and update in the same transaction
3. A `SAVEPOINT` around the INSERT, roll back to it on conflict
4. `pg_advisory_xact_lock(hash(fingerprint))` before the SELECT
5. `SERIALIZABLE` isolation with retry on serialization failures

## Decision outcome

**Option 1.** The use case `IngestAlert` (ingestion/application) runs:

```
prepare (pure: indicators, raw cap, fingerprint)          ← outside the transaction
BEGIN (READ COMMITTED)
  idempotency record (scope, key) live?   → same hash: replay it   · other hash: 409
  SELECT … FROM alerts WHERE fingerprint = $1 AND status NOT IN (closed) FOR UPDATE
    found → UPDATE duplicate_count + 1, last_seen_at = greatest(...);  alert.deduplicated
    none  → INSERT alert;                                              alert.ingested {alert}
  INSERT idempotency record … ON CONFLICT DO UPDATE … WHERE created_at < now − 24 h
    0 rows → a live record appeared: LostRace
COMMIT
on OpenAlertExistsError (23505 on alerts_open_fingerprint_uq) or LostRace → run it all again (max 5)
```

- `FOR UPDATE` serializes concurrent duplicates of an _existing_ open alert, so 19 increments
  really add up to 19.
- When the INSERT loses, Postgres makes it wait for the winner's commit and then raises 23505.
  A unique violation **aborts the transaction**, so we can't "just continue as a duplicate" in
  it; re-running the unit is the simplest correct thing, and on the second run the SELECT sees
  the winner's row.
- The alerts module owns the table, so the SQL lives behind `AlertsPublicApi`
  (`findOpenByFingerprint`, `recordDuplicate`, `create`), which take the caller's transaction
  executor. `create` translates the 23505 into the typed `OpenAlertExistsError`.
- Idempotency record details: `scope` is `user:<id>` or `webhook:<sourceId>`; the request hash
  is sha256 of the **raw body** for webhooks and of a key-sorted JSON serialization of the
  parsed body for `POST /alerts` (so a client that re-serializes with different key order is
  still "the same request"); only successful (202) results are stored, because failures are
  deterministic and cheap to recompute; expired records are overwritten in place, and a
  background task deletes them (every 15 min, 24 h TTL).
- Batch import does not take an Idempotency-Key (the contract doesn't list one); each line is
  its own transaction, so a resent batch counts lines as duplicates rather than creating alerts.

The integration test `collapses 20 concurrent ingests…` uses a barrier to make several
transactions INSERT at the same moment. Without it the first transaction always finished
before the others got a pooled connection, so the race never happened and the test passed
even with retries disabled (see the [journal](../journal/2026-10-28-ingestion-alerts.md)).

### Consequences

- 👍 Correctness rests on a database constraint, not on timing.
- 👍 One code path for both races (alert insert and idempotency key).
- 👎 A lost race costs a second transaction. Only the first burst of an alert pays it; once the
  row exists every copy takes the `FOR UPDATE` path.
- 👎 Hot alerts serialize on one row lock. Fine at hundreds of alerts/s; a storm of thousands
  of identical alerts per second would queue on that row.

## Pros and cons of the options

### `ON CONFLICT DO NOTHING`

- 👍 No aborted transaction, no retry loop.
- 👎 Partial-index inference (`ON CONFLICT (fingerprint) WHERE …`) is easy to get subtly wrong,
  and the "find again after DO NOTHING" step is the same retry logic in disguise. A good
  alternative; we preferred the version that is easier to explain.

### `SAVEPOINT`

- 👍 Keeps the outer transaction alive.
- 👎 Not available in Kysely's callback transaction API (only `startTransaction()`), and a
  savepoint per insert costs a round trip on the happy path too.

### Advisory locks

- 👍 Fully serializes per fingerprint, no retries.
- 👎 Takes a lock on _every_ ingest, including the happy path, and correctness then depends on
  every writer remembering to take it. The unique index can't be forgotten.

### `SERIALIZABLE`

- 👍 The textbook answer.
- 👎 Retries on unrelated conflicts too (predicate locks), and harder to reason about for learners.

## What would make us revisit this

- Lost-race retries above ~1 % of ingests in production metrics.
- A requirement for idempotency on batch imports (store a per-batch key and per-line results).

## Further reading

- PostgreSQL docs, _Transaction Isolation_ (13.2) and _INSERT … ON CONFLICT_
- Brandur Leach, _Implementing Stripe-like Idempotency Keys in Postgres_ (2017)
- Martin Kleppmann, _Designing Data-Intensive Applications_, ch. 7 (write skew and phantoms)
