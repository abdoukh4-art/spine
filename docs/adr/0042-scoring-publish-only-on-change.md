# ADR-0042: Scoring is idempotent per (alert, ruleset) and publishes only on change

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** enrichment + scoring workstream
- **Tags:** architecture, data

## Context and problem statement

`scoring.on-alert-enriched` consumes `alert.enriched`. It receives:

- **duplicates**: the same event redelivered (at-least-once, [ADR-0009](0009-domain-events-transactional-outbox.md));
- **legitimate repeats**: a new `alert.enriched` after `POST /alerts/:id/enrich`, which
  may or may not change the score;
- **out-of-order events**: two `alert.enriched` events for one alert handled by two
  workers, where the older one finishes last.

`alert_scores` already has the key `(alert_id, ruleset_version)`. The question is when to
publish `alert.scored`. That event updates the alerts projection and drives playbook
triggers, so a spurious one can start a playbook evaluation for nothing.

## Decision drivers

- A redelivered event must not publish twice (even concurrently).
- A **changed** score must be published, otherwise the alert queue shows a stale score.
- An older snapshot must never overwrite a newer score.
- No new infrastructure.

## Considered options

1. **Change detection on the stored explanation**, with a snapshot timestamp guard.
2. **Inbox table keyed by event id** (as enrichment does, [ADR-0040](0040-enrichment-idempotent-receiver.md)).
3. **Always upsert and always publish**, leaving duplicates to consumers.

## Decision outcome

**Chosen option 1.** One transaction does:

1. `INSERT … ON CONFLICT (alert_id, ruleset_version) DO NOTHING RETURNING`. If a row comes
   back, it's the first score: publish.
2. Otherwise `SELECT … FOR UPDATE` the row, so concurrent deliveries serialize here, along with
   `(explanation - 'computedAt') = (new - 'computedAt')` computed **as jsonb** (key order
   doesn't matter).
3. If the event's snapshot time (`alert.enriched.occurredAt`, stored in the new column
   `source_occurred_at`, migration 0501) is **older** than the stored one: do nothing.
4. Otherwise always advance `source_occurred_at`. Replace the explanation and publish
   `alert.scored` **only if** it differs.

Step 4's "always advance" is the subtle part. Our first version folded everything into
one `ON CONFLICT DO UPDATE … WHERE newer AND different`. An identical newer snapshot then
updated nothing, not even the timestamp, so a **stale** snapshot that arrived afterwards
passed the "newer than stored" check and overwrote the score. The journal entry for this
day walks through how we found it. The test
`scoring.test.ts › re-scores when newer enrichment changes the score, ignores stale snapshots`
pins the exact sequence.

The `spine_alerts_scored` counter is incremented only when we publish, so redeliveries
don't inflate it.

### Consequences

- 👍 Idempotent without an extra table: a duplicate produces an identical explanation
  (the engine is deterministic, [ADR-0015](0015-explainable-rule-based-scoring.md)), so it is a no-op.
- 👍 A re-enrichment that doesn't change the score publishes nothing, so playbooks
  aren't re-triggered for nothing.
- 👍 Out-of-order delivery is handled.
- 👎 The comparison costs one extra `SELECT … FOR UPDATE` per non-first delivery.
- 👎 "Different" includes evidence text and data gaps, not only the number. A changed data
  gap with the same score still publishes. That's intentional: the explanation the analyst
  sees changed.
- ⚖️ A new ruleset version yields a new row (new key). Re-scoring existing alerts under
  a new version is an explicit backfill, not something that happens implicitly.

## Pros and cons of the options

### Inbox keyed by event id

- 👍 Uniform with enrichment.
- 👎 Doesn't help with legitimate repeats (new event id, same score) or with
  out-of-order events. We'd still need the change and staleness logic.

### Always publish

- 👍 Simplest.
- 👎 Duplicate `alert.scored` events re-run playbook trigger matching. That relies on every
  playbook-side guard being perfect.

## What would make us revisit this

- PostgreSQL 18's `RETURNING OLD/NEW` would allow a single-statement version → simplify.
- Scores get large (hundreds of factors) and the jsonb comparison shows up in profiles →
  store a hash of the explanation (minus `computedAt`) and compare hashes.

## Further reading

- Pat Helland, _Idempotence Is Not a Medical Condition_ (ACM Queue, 2012)
- PostgreSQL docs, _INSERT … ON CONFLICT_ and _SELECT … FOR UPDATE_
