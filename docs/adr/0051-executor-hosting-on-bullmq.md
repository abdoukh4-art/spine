# ADR-0051: Hosting the executor on BullMQ: one job = one `advance`, timers as delayed jobs

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** playbooks workstream
- **Tags:** architecture, ops

## Context and problem statement

The engine ([ADR-0050](0050-playbook-engine-reduce-decide-act.md)) stops when a run must
wait: for a human (approval) or for time (retry backoff, approval deadline). Something must
wake it up again, survive restarts and a wiped Redis ([ADR-0008](0008-bullmq-redis-job-queue.md)),
and avoid two workers advancing the same run at once as much as possible.

## Decision drivers

- Postgres is the source of truth; Redis holds only re-creatable state.
- No worker may sleep while holding a run (approvals can take hours).
- Duplicated wake-ups must be harmless; lost wake-ups must be recovered automatically.

## Considered options

1. **One BullMQ job = one `advance(runId)` call; the outcome schedules the follow-up job** (a delayed job for `retry_scheduled`, an immediate one when the iteration guard yields, nothing when waiting for a human or terminal). Deterministic job IDs; a startup reconciler; a periodic approval-expiry sweeper.
2. A long-lived job per run that loops and sleeps until done.
3. A Postgres "timers" table polled by the worker.

## Decision outcome

**Chosen option 1.**

- Job payload is `{ runId }` only. Job ID `run__<runId>__<lastSeq>` (`:` is reserved by
  BullMQ). The same run at the same log position can be queued once at a time; any number
  of producers (outbox subscriber, API fast path, approval decision, reconciler) may
  enqueue it without coordination.
- Delayed retry jobs use `run__<runId>__<seq>__<notBeforeMs>__<scheduledAtMs>`. The
  `scheduledAt` part exists because a delayed job that fires slightly early (clock skew)
  re-schedules itself while still active; with the same ID BullMQ would silently drop the
  add and the run would stall until the next restart.
- `removeOnComplete: true`, so an ID can be reused after its job finished;
  `attempts: 5` with exponential backoff for infrastructure errors (DB down), which the
  engine surfaces as exceptions rather than step failures.
- **Enqueue paths:** a new run publishes `playbook.run.requested` in its creating
  transaction; the `playbooks.enqueue-requested-run` subscriber enqueues it (the outbox
  makes this reliable). Approval decisions publish `approval.decided` the same way. The
  API also enqueues directly after commit as a latency shortcut; failures there are only logged.
- **Startup reconciler** (worker background task): every run in `pending`, `running` or
  `compensating` is enqueued at its `last_seq`. Runs in `waiting_approval` are not: only
  a decision or the sweeper can move them.
- **Approval-expiry sweeper** every `PLAYBOOK_APPROVAL_SWEEP_INTERVAL_MS` (30 s): marks
  overdue approvals `expired`, appends `approval.granted|rejected {reason: timeout}`
  according to `onTimeout`, and enqueues the run.
- Worker concurrency `PLAYBOOK_WORKER_CONCURRENCY` (4) is a bulkhead: slow playbooks
  cannot starve the event pipeline, which has its own queue and workers.
- On shutdown the worker aborts in-flight handlers through the engine's host signal; the
  step stays "started" and resumes with the same key on the next run.

### Consequences

- 👍 A wiped Redis costs latency, not correctness: the reconciler rebuilds the queue
  (integration-tested).
- 👍 No worker is ever blocked by a human.
- 👎 Two jobs for the same run at different `seq`s can run concurrently (e.g. a reconciler
  job and a decision job). Optimistic concurrency makes this safe: the loser of an append
  reloads and continues (integration-tested with a forced race).
- 👎 Approval deadlines are enforced with up to one sweep interval of delay.

## Pros and cons of the options

### Long-lived job per run

- 👍 Simple mental model.
- 👎 Holds a worker slot for hours; a crash loses the in-memory wait; BullMQ stalled-job
  detection would fight long sleeps.

### Postgres timers table

- 👍 Timers in the same transaction as the log.
- 👎 Another polling loop and table; BullMQ already provides delayed jobs.

## What would make us revisit this

- Thousands of concurrently waiting retries → a timers table with an index on `not_before`.
- Need for exact deadline enforcement → a delayed job per approval instead of a sweep.

## Further reading

- BullMQ docs: _Job IDs_, _Delayed jobs_, _Stalled jobs_
- Martin Kleppmann, _Designing Data-Intensive Applications_, ch. 11 (stream processing, idempotence)
