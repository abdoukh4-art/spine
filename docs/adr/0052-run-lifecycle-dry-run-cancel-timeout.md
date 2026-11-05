# ADR-0052: Run lifecycle semantics: dry-run, cancellation, approval timeouts

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** playbooks workstream
- **Tags:** architecture, security

## Context and problem statement

The DSL ([ADR-0013](0013-playbook-dsl.md)) names dry-run, approval timeouts and
cancellation but does not define their edge cases. Each one has a "surprising" choice
that analysts will hit; writing them down avoids three different answers in three places.

## Decision drivers

- Dry-run must be safe to press at any time: no response action, no state change visible
  to other modules, no human interrupted.
- Cancelling must be immediate and predictable.
- An approval that nobody answers must not block a run forever.

## Considered options

For each question we considered the two obvious answers:

1. Dry-run approvals: **skip (assume granted)** vs. still wait for a human.
2. Cancel: **stop without compensation** vs. compensate completed steps.
3. Timeout: **approval row `expired` + run event `approval.granted|rejected {reason: timeout}`** vs. a new run event type.

## Decision outcome

1. **Dry-run skips approval gates** (`step.skipped {reason}`) and follows `next`.
   Handlers receive `dryRun: true`: simulated adapters record their would-be effect with
   `dry_run = true`, `set_status` records an `alert.set_status` preview instead of calling
   the alerts module, `score` asks the scoring gateway not to persist, and fault injection
   is disabled so previews are deterministic. `enrich` still calls the enrichment
   gateway: reputation lookups are read-only towards the outside world.
2. **Cancellation appends `run.cancelled` and does not compensate.** Cancelling is "stop
   now", typically because an analyst took over by hand; silently unblocking an IP they
   might rely on would be worse. Pending approvals of the run are marked `expired`.
   Cancel races with the executor through optimistic concurrency and retries up to three
   times. A step that was mid-flight when the cancel landed may still have taken effect;
   its result is simply not recorded (visible in `simulated_actions`).
3. **Timeouts reuse the existing event types** with `reason: "timeout"` in the payload, and
   the approval row becomes `expired` whatever `onTimeout` says. The domain event
   `approval.decided` carries `decision: "expired"`. A new event type would have forced a
   reducer case that behaves exactly like granted/rejected.
4. Manual runs are allowed for **disabled** playbooks: `enabled` only controls automatic
   triggering, so a disabled playbook can still be tested with a dry run.
5. Approval decisions check the approver role (`approverRole: admin` cannot be decided by
   an analyst → 403) and the deadline (`409` once expired, even before the sweeper ran).

### Consequences

- 👍 Dry runs never touch real state and never page a human.
- 👎 A dry run cannot exercise the reject branch of an approval. Run a real run on a test
  alert for that, or add a `dryRunDecision` option later.
- 👎 Cancelling after a block leaves the block in place; the console must say so.

## Pros and cons of the options

### Dry-run waits for approvals

- 👍 Exercises the full path including humans.
- 👎 Pages analysts for a rehearsal; approvals inbox fills with noise.

### Cancel compensates

- 👍 "Undo everything" is tidy.
- 👎 Surprising during manual incident handling; compensation itself can fail and leave a
  half-undone state. Can be added as an explicit "cancel and roll back" action later.

## What would make us revisit this

- Analysts ask for "cancel and roll back" → add `run.cancel_requested {compensate: true}`.
- Dry runs need to test rejection paths → per-run `dryRunDecisions` input.

## Further reading

- Chris Richardson, _Pattern: Saga_ (microservices.io)
