# ADR-0036: `resolvedAt` is the first close and never moves; same-status updates are no-ops

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** alerts workstream
- **Tags:** data

## Context and problem statement

The alert state machine (api-contract.md) allows reopening: `resolved | false_positive →
in_progress`. That raises questions the contract doesn't answer:

1. When an alert is closed, reopened and closed again, what is `resolved_at`?
2. Is setting the status an alert already has an error?
3. Reopening makes the alert _open_ again, but the partial unique index allows only one open
   alert per fingerprint ([ADR-0012](0012-idempotency-and-deduplication.md)). What if a newer
   alert with the same fingerprint was created after the close?

[ADR-0026](0026-mttd-mttr-definitions.md) defines TTR with "`resolvedAt` = the **first**
transition to `resolved` or `false_positive`".

## Decision drivers

- Consistency with ADR-0026 (MTTR must be computable from this column alone).
- MTTR must not be gameable by reopen-and-reclose.
- Automation (playbook `set_status` steps) is delivered at least once and must be safely retryable.

## Considered options

For `resolved_at`:

1. **Keep the first close forever (never cleared, never moved)**
2. Clear it on reopen, set it again on the next close (last close)
3. Keep a history table of every close

For same-status updates: **no-op** vs `409`.

For reopen collisions: **`409 Conflict`** vs closing the newer alert automatically vs merging.

## Decision outcome

- **`resolved_at` = first close, kept forever.** A reopened alert therefore has
  `status = in_progress` _and_ a non-null `resolvedAt`. MTTR (ADR-0026) must filter on
  "status is closed" for "closed alerts", and use `resolvedAt` as the end time. Implemented in
  the pure `planStatusChange` (alerts/domain), tested by unit and property tests and by the
  integration test `keeps the FIRST resolvedAt across reopen and re-close`.
- **Same status → no-op**: no write to status, no `alert.status_changed` event, `200` with the
  current summary. A playbook retry of `set_status: resolved` succeeds instead of failing.
- **Reopen collision → `409`** with "another open alert with the same fingerprint already
  exists": the analyst should work on the newer alert (or close it first).
- Every real transition emits `alert.status_changed {alertId, from, to, actorId, at}` in the
  same transaction; `actorId` is null for automation.

### Consequences

- 👍 MTTR is stable: reopening can't shorten or lengthen a past resolution time.
- 👍 Status updates are idempotent for at-least-once callers.
- 👎 "Resolved at" shown on a reopened alert can surprise a reader. The console should label it
  "first resolved".
- 👎 Time spent after a reopen is not captured by MTTR. If that matters, ADR-0026's revisit
  trigger (case-level MTTR / a history) applies.

## Pros and cons of the options

### Last close

- 👍 Intuitive for a single alert's timeline.
- 👎 Contradicts ADR-0026, and lets an old alert be "re-resolved" to change historical metrics.

### Close history table

- 👍 Complete story.
- 👎 More schema and code for a question nobody has asked yet; the outbox events
  (`alert.status_changed`) already record every transition for a future projection.

### Same status → 409

- 👍 Strict.
- 👎 Breaks retries of automation for no benefit.

## What would make us revisit this

- A requirement to report time-to-final-resolution, or reopen rates (build a projection from `alert.status_changed`).

## Further reading

- ADR-0026, the MTTR definition this decision implements
