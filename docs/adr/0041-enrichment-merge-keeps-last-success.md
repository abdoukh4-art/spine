# ADR-0041: Stored enrichment keeps the last success; events carry the merged view

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** enrichment + scoring workstream
- **Tags:** data

## Context and problem statement

`alert_enrichments` holds one row per `(alert, provider, indicator)`. A row can be
written more than once: by the first enrichment, by `POST /alerts/:id/enrich` after an
outage, or by the playbook `enrich` step. That raises three questions:

1. A re-run fails (`timeout`, `circuit_open`…) where an earlier run succeeded. Which one
   do we keep?
2. Two runs finish out of order (the older one commits last). Which one wins?
3. A re-run may cover only some providers. What does `alert.enriched` carry: this run's
   results, or everything we know?

## Decision drivers

- Analysts and scoring should see the **best available** data.
- No silent data loss because of an outage.
- Out-of-order commits must not regress the data.
- Scoring needs the full picture in one payload (event payloads are snapshots, see the
  [event catalog](../architecture/event-catalog.md)).

## Considered options

1. **Last write wins**: plain upsert.
2. **Newest wins, except that a failure never replaces a success**, enforced in the upsert.
3. **Keep history**: append-only rows, with readers picking the best one.

## Decision outcome

**Chosen option 2**, enforced in SQL so concurrent writers can't break it:

```sql
INSERT … ON CONFLICT (alert_id, provider, indicator_type, indicator_value) DO UPDATE SET …
WHERE excluded.fetched_at >= alert_enrichments.fetched_at
  AND (excluded.status NOT IN ('error','timeout','circuit_open','rejected')
       OR alert_enrichments.status IN ('error','timeout','circuit_open','rejected'))
```

- A newer success replaces anything. A newer failure replaces only an older failure.
- `not_found` counts as a success: the provider answered.
- After the upsert, the handler reads back **all** rows for the alert inside the same
  transaction, and publishes that merged set in `alert.enriched`. `EnrichmentPublicApi.enrichAlert`
  returns the same merged set.

### Consequences

- 👍 A provider outage after a successful enrichment never erases the good data. A low
  score caused by an outage gets fixed by a re-enrich once the provider is back.
- 👍 Scoring always gets the complete, best-known picture, whichever run triggered it.
- 👎 Data can be stale: a reputation verdict from yesterday survives today's timeout.
  `fetchedAt` is on every result, so the UI can show its age.
- 👎 A provider that legitimately changed its answer to "unknown" while another call
  timed out is not distinguishable from an outage. That's acceptable: `not_found` is a
  success and does replace.
- ⚖️ Failed rows are stored too, so the explanation's data gaps survive in the database,
  not only in the event.

## Pros and cons of the options

### Last write wins

- 👍 Simplest.
- 👎 One `circuit_open` re-run wipes out good data. Out-of-order commits regress it.

### Append-only history

- 👍 Full audit of every lookup.
- 👎 Every reader has to implement "pick the best row", and the table grows with every
  re-run. History is not a requirement here (unlike playbook runs, [ADR-0010](0010-event-sourcing-for-playbook-runs-only.md)).

## What would make us revisit this

- Provider data with a short shelf life (e.g. a live "is this IP currently attacking"
  feed) → add a TTL per provider, after which a failure _does_ replace a success.
- Auditors need the history of lookups → add an append-only `enrichment_lookups` log next
  to the current-state table.

## Further reading

- Martin Kleppmann, _Designing Data-Intensive Applications_, ch. 5, "Handling write conflicts"
  (last-write-wins and why it loses data)
