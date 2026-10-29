# ADR-0010: Event sourcing only for playbook run history; state-based storage elsewhere

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture, data

## Context and problem statement

Event sourcing stores the _sequence of facts_ that happened, instead of the current state,
and derives state by folding over those events. It is powerful but costly: projections,
versioning of event schemas, snapshotting and a harder mental model. Where, if anywhere,
does Spine need it?

## Decision drivers

- Playbook runs need a **complete, ordered, immutable execution history** (requirement:
  "full execution history"), and they must **resume after a crash** from exactly where they stopped.
- Auditors need to see exactly what automation did, and when.
- Most other data (users, cases, alert status) is simple CRUD where history is covered by the audit log.

## Considered options

1. **Event-source playbook runs only**
2. Event-source everything (alerts, cases, users)
3. Event-source nothing: a mutable `playbook_runs.state` JSON column plus a separate log table

## Decision outcome

**Chosen option 1.**

- `playbook_run_events(run_id, seq, type, step_id, payload, occurred_at)` with
  `PRIMARY KEY (run_id, seq)`. Appends use optimistic concurrency: the writer supplies the
  `seq` it expects, and a unique violation means another worker raced it and must reload.
- `packages/playbook-engine` has a pure `reduce(events) → RunState` function. Resuming
  after a crash = load events → reduce → continue from the first step that has no
  terminal event.
- `playbook_runs` keeps a denormalized **projection** (status, current step, timestamps),
  updated in the same transaction as the append, for cheap listing and filtering.
- Everything else (alerts, cases, users) is **state-based**. Their history is captured by
  `audit_log` ([ADR-0016](0016-authentication-jwt-refresh-rotation.md)) and domain events.

### Consequences

- 👍 Crash recovery is a pure function, so it can be property-tested ([ADR-0021](0021-testing-strategy.md)).
- 👍 The run timeline in the console is just the event list.
- 👎 Run event schemas must stay backward compatible. Rule: add fields, never repurpose;
  new event types require a reducer case and a test.
- 👎 Two representations (events + projection) must stay consistent. Mitigated by writing
  both in one transaction and by a test that rebuilds the projection from events.

## Pros and cons of the options

### Event-source everything

- 👍 Uniform model, with time-travel for all entities.
- 👎 Massive complexity for CRUD data, plus projections everywhere. Classic over-engineering.

### Event-source nothing

- 👍 Simplest.
- 👎 Resume logic depends on a mutable blob that can be half-written. History and state can disagree.

## What would make us revisit this

- Analysts need "what did this alert look like at 14:03?" time-travel. Then consider
  event-sourcing alerts.
- Run event volume becomes large (> 100 events/run on average). Then add snapshots.

## Further reading

- Greg Young, _CQRS Documents_ (2010)
- Martin Fowler, _Event Sourcing_ (bliki)
- Temporal, _Event History_ concepts (the same idea applied to durable workflows)
