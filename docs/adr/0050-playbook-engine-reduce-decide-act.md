# ADR-0050: Playbook engine as reduce → decide → act, with attempt-scoped idempotency keys

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** playbooks workstream
- **Tags:** architecture

## Context and problem statement

[ADR-0010](0010-event-sourcing-for-playbook-runs-only.md) decided that playbook runs are
event-sourced and [ADR-0013](0013-playbook-dsl.md) fixed the DSL. Neither says how the
engine turns an event log into actions, what exactly gets recorded around a side effect,
or what "resume after a crash" means for a step that was half-done. These details decide
whether a crash can duplicate a firewall block, so they deserve their own record.

## Decision drivers

- A worker may die at any instruction; no completed action may be repeated, and no
  started action may be lost (vision goal G4, success metric S6).
- The core must be pure so it can be property-tested (crash at every point).
- The timeline shown to analysts must be the event log itself.
- Hosts (API, worker, tests) must be able to run the engine with different storage.

## Considered options

1. **Three pure/impure layers: `reduce(definition, events) → state`, `decide(definition, state, now) → action`, `advance()` acts through ports.** Record `step.started` before a side effect and the result after; a step that has `started` but no result is re-executed with the same attempt number, so with the same idempotency key `${runId}:${stepId}:${attempt}`.
2. A stateful executor object that keeps the current step in memory and checkpoints a snapshot after each step.
3. Record only results (`step.succeeded`), not starts, and rely on the adapter's idempotency key `${runId}:${stepId}` alone.

## Decision outcome

**Chosen option 1.**

- `reduce` is a fold of `applyEvent`; it rejects seq gaps and unknown steps (corrupt logs
  fail loudly).
- `decide` returns one of `ExecuteStep{stepId, attempt, resume}`, `ScheduleRetry`,
  `WaitForRetry`, `RequestApproval`, `WaitForApproval`, `SkipStep`, `Compensate`,
  `Finish`, `Halt`. The brief listed six kinds; we added three, because "wait until
  `notBefore`", "skip in dry-run" and "nothing to do, the run is terminal" are different
  situations that the host must not have to infer.
- **Idempotency key per attempt**, not per step. A retry after a _failure_ is a new attempt
  with a new key: replaying the first key against a real API would return the cached
  failure. A re-execution after a _crash_ is the same attempt with the same key, so the
  adapter returns the original result instead of acting twice.
- **Branches are decided once and recorded.** `step.succeeded {output: {taken}}` is
  appended together with `step.started`; replays read `taken`, never re-evaluate.
- **Approval requests are recorded atomically with their start** (`step.started` +
  `approval.requested` in one append), because the approval handler is idempotent on
  `(run_id, step_id)`, so there is nothing to protect between the two.
- Retry backoff is deterministic: `backoffMs × 2^(attempt−1)`, capped at 10 minutes. No
  jitter in the engine (it would make logs non-reproducible); the queue is the place for it.
- Handler outputs are normalized through JSON so an in-memory run and a stored run are
  byte-for-byte the same, which the crash-resume property test relies on.

### Consequences

- 👍 Crash recovery is "load, reduce, decide": property tests truncate or crash the log
  at every point and check the final log is identical and keys never change.
- 👍 The same engine runs in the worker, in tests (in-memory store) and could run in a CLI.
- 👎 A crash _between_ the side effect and `step.succeeded` re-invokes the handler. That
  is only safe because every response adapter honours idempotency keys (ADR-0018). A
  future real adapter that ignores keys would double-act; reviewers must check this.
- 👎 Two workers that both see "started, not finished" both run the handler (same key).
  Correct, but wasteful; see [ADR-0051](0051-executor-hosting-on-bullmq.md) for why this is rare.
- ⚖️ Branch evaluation happens in the executor, not a handler; the timeline still shows it
  as a step with `started`/`succeeded`.

## Pros and cons of the options

### Stateful executor with snapshots

- 👍 Fewer events.
- 👎 Snapshot and reality can disagree after a crash mid-write; recovery logic becomes
  special-case code instead of the normal path. This is what ADR-0010 rejected.

### Results only, key per step

- 👍 Simpler log.
- 👎 Cannot tell "never started" from "crashed mid-step", and a failed attempt's key would be
  reused on retry, so a real API would replay the failure forever.

## What would make us revisit this

- Runs with > 100 events on average → snapshot the reduced state every N events.
- Parallel branches (ADR-0013 revisit) → the state needs several tokens instead of one
  `currentStepId`, and `decide` returns a set of actions.

## Further reading

- Temporal, _Workflow execution and event history_ (same idea, industrial scale)
- Pat Helland, _Idempotence Is Not a Medical Condition_ (ACM Queue, 2012)
- Hector Garcia-Molina & Kenneth Salem, _Sagas_ (1987)
