# ADR-0008: BullMQ on Redis for playbook and pipeline jobs

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture

## Context and problem statement

Playbook runs can last minutes or hours (approval gates) and must survive process crashes.
Enrichment calls are slow and must not block the HTTP request that ingested the alert. We
need a job queue with retries, delays, concurrency limits and visibility.

## Decision drivers

- At-least-once delivery with retries and backoff.
- Delayed jobs (step retry backoff, approval timeouts).
- Per-queue concurrency limits (bulkheads between pipeline stages).
- Mature, well-documented, with metrics hooks.

## Considered options

1. **BullMQ + Redis 7**
2. Postgres-backed queue (pg-boss / graphile-worker)
3. RabbitMQ
4. Temporal (a durable workflow engine)

## Decision outcome

**Chosen option: BullMQ.** Queues:

| Queue                 | Producer         | Consumer                                                    | Concurrency (default) |
| --------------------- | ---------------- | ----------------------------------------------------------- | --------------------- |
| `spine.events`        | outbox relay     | event handlers (enrichment, scoring, triggers, projections) | 8                     |
| `spine.playbook-runs` | playbooks module | playbook executor                                           | 4                     |

**The queue is not the source of truth.** A playbook job contains only `{ runId }`. All
run state lives in Postgres as an append-only event log ([ADR-0010](0010-event-sourcing-for-playbook-runs-only.md)).
If Redis is wiped, a startup reconciler re-enqueues every run whose status is not terminal.
Jobs use deterministic `jobId`s (`run:<runId>:<seq>`) so duplicates are ignored.

### Consequences

- 👍 Retries, delays, rate limits and concurrency come for free, and jobs are inspectable.
- 👍 The worker process (`apps/api/src/worker.ts`) scales independently of the API.
- 👎 Redis is a second stateful dependency. Mitigated: it holds only re-creatable state.
- 👎 BullMQ is at-least-once, so handlers **must be idempotent**. That's enforced by design
  (step results are keyed by `runId + stepId`, and action adapters receive idempotency keys).

## Pros and cons of the options

### pg-boss / graphile-worker

- 👍 No Redis at all, and the queue lives in the same transaction as state.
- 👎 Polling load on the primary DB, and a smaller ecosystem. The mission mandates BullMQ,
  and its exposure is valuable for the target job market. The outbox relay _does_ use
  Postgres `SKIP LOCKED`, so learners see both styles.

### RabbitMQ

- 👍 A real broker with routing.
- 👎 Heavier to operate, and delayed messages need a plugin.

### Temporal

- 👍 Exactly built for durable workflows.
- 👎 A large extra cluster to run. It hides the durable-execution mechanics that this
  project wants to _teach_ by implementing them in `packages/playbook-engine`.

## What would make us revisit this

- Playbooks grow into long-running, multi-day workflows with complex timers. Then Temporal earns its cost.
- Redis availability becomes a recurring incident cause.

## Further reading

- BullMQ docs: _Retrying failing jobs_, _Job IDs_, _Graceful shutdown_
- Temporal blog, _Durable execution explained_
