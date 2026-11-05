# ADR-0038: The score projection ignores scores older than the one already applied

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** alerts workstream
- **Tags:** data, architecture

## Context and problem statement

The Alerts module keeps `alerts.score` and `alerts.severity` up to date by handling
`alert.scored` events (subscriber `alerts.project-score`). Delivery is **at least once** and
BullMQ retries can **reorder** deliveries ([ADR-0009](0009-domain-events-transactional-outbox.md)).
An alert can be scored more than once (re-enrichment after an outage, a new ruleset, the
playbook `score` step). If the older score's delivery is retried after the newer one, a plain
`UPDATE … SET score = $1` writes the stale value last, and the queue shows the wrong priority.

## Decision drivers

- Handlers must be idempotent (ADR-0009) **and** order-insensitive.
- Stay inside the Alerts module's own table (no reading `alert_scores`, which Scoring owns).

## Considered options

1. **Store the `computedAt` of the applied score (`alerts.scored_at`, migration 0201) and update only if the incoming one is not older**
2. Last write wins (plain UPDATE)
3. Track processed `eventId`s in an inbox table
4. Re-read the latest score from the Scoring public API on every event

## Decision outcome

**Option 1.**

```sql
UPDATE alerts SET score = $score, severity = $severity, scored_at = $computedAt
 WHERE id = $alertId AND (scored_at IS NULL OR scored_at <= $computedAt)
```

`<=` (not `<`) makes an exact redelivery a harmless re-write of the same values. The column is
added by a new migration (`0201_alerts_scored_at.sql`) because applied migrations are immutable.

### Consequences

- 👍 Idempotent and commutative: any delivery order converges to the newest score.
- 👍 One extra nullable column, no extra table, no cross-module call.
- 👎 Relies on Scoring's clock (`computedAt`) being monotonic for one alert. Both run in our
  worker fleet with NTP; two scores computed within the same millisecond on skewed hosts could
  still race. Acceptable.

## Pros and cons of the options

### Last write wins

- 👍 Trivial.
- 👎 Wrong under reordering, which our transport explicitly allows.

### Inbox table of processed event ids

- 👍 General-purpose idempotency for any handler.
- 👎 Solves duplicates, not reordering; still needs the ordering guard.

### Re-read from Scoring

- 👍 Always the latest truth.
- 👎 A synchronous cross-module call per event, and the Scoring API is not wired in Phase 1.

## What would make us revisit this

- Scores that must be applied by ruleset version rather than time (compare `rulesetVersion` first).

## Further reading

- Martin Kleppmann, _Designing Data-Intensive Applications_, ch. 11 ("Ordering events")
- Pat Helland, _Idempotence Is Not a Medical Condition_ (ACM Queue, 2012)
