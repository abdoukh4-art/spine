# ADR-0055: Rebuild the run projection and emit domain events inside every append

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** playbooks workstream
- **Tags:** data, architecture

## Context and problem statement

[ADR-0010](0010-event-sourcing-for-playbook-runs-only.md) keeps a `playbook_runs`
projection next to the event log and requires both to be written in one transaction. Three
writers append to a run's log (the executor, approval decisions, cancellation) and several
appends imply cross-module domain events (`approval.requested`, `approval.decided`,
`playbook.run.finished`). Where should the projection update and the event mapping live so
that no writer can forget them?

## Decision drivers

- The projection and the outbox must never disagree with the log.
- Use cases need to group several writes (lock an approval, update it, append) atomically
  without importing Kysely ([ADR-0002](0002-hexagonal-modular-monolith.md)).

## Considered options

1. **The Postgres `RunStore.append` does it all in one transaction: bump `last_seq` from the expected value (0 rows → `ConcurrencyError`), insert events, re-reduce the full log, rewrite the projection, publish the domain events implied by the new events. Use cases get a unit-of-work port (`store.transaction(uow => …)`) whose repositories share the transaction.**
2. Each use case updates the projection and publishes events itself.
3. Incrementally update the projection from the new events only.

## Decision outcome

**Chosen option 1.**

- The optimistic-concurrency check is an `UPDATE … WHERE last_seq = expected`, which
  serializes concurrent appenders on the row lock; the `(run_id, seq)` primary key remains
  a second line of defence (a unique violation is also mapped to `ConcurrencyError`).
- The mapping from run events to domain events is a pure domain function
  (`domainEventsFor`), unit-tested.
- Run-finished metrics are recorded by the same adapter after the append returns.

### Consequences

- 👍 Every writer, including future ones, keeps projection and outbox consistent for free.
  An integration test rebuilds every projection from events and compares.
- 👎 Each append re-reads and re-reduces the whole log: O(n) per append, O(n²) per run.
  With < 50 events per run this is microseconds; see "revisit".

## Pros and cons of the options

### Each use case does it

- 👍 Explicit.
- 👎 One forgotten call corrupts the read side; three writers today, more tomorrow.

### Incremental projection

- 👍 O(1) per append.
- 👎 Needs the previous state, i.e. a second source of truth or another read anyway.

## What would make us revisit this

- Runs exceed ~200 events → snapshot reduced state alongside `last_seq`, reduce only the tail.

## Further reading

- Vaughn Vernon, _Implementing Domain-Driven Design_, ch. 8 (domain events) and appendix A (event sourcing)
