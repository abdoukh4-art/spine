# Domain event catalog

> Normative source: [`packages/shared-schema/src/events.ts`](../../packages/shared-schema/src/events.ts).
> Transport: transactional outbox → BullMQ fan-out, at-least-once ([ADR-0009](../adr/0009-domain-events-transactional-outbox.md)).
> **Every handler must be idempotent.** Use `eventId` or a natural key.

## Envelope

```ts
interface DomainEvent<TType extends string, TPayload> {
  eventId: string;        // UUIDv7, unique, used for idempotency
  type: TType;            // e.g. "alert.ingested"
  version: number;        // payload schema version, starts at 1
  aggregateId: string;    // the entity the event is about (alertId, runId…)
  occurredAt: string;     // ISO-8601
  payload: TPayload;      // validated by the per-type Zod schema
  traceparent?: string;   // W3C trace context to continue the trace across the async hop
}
```

## Events

| Type (v) | Producer | Payload | Consumers | Notes |
|---|---|---|---|---|
| `alert.ingested` (1) | ingestion | `{alert: Alert}` (full canonical alert with id, fingerprint, receivedAt) | enrichment, alerts (projection: none needed, already written), metrics | Emitted only for **new** alerts, not duplicates |
| `alert.deduplicated` (1) | ingestion | `{alertId, fingerprint, duplicateCount, lastSeenAt}` | (metrics) | Not re-enriched |
| `alert.enriched` (1) | enrichment | `{alert: Alert, enrichments: EnrichmentResult[]}` | scoring | Includes failed lookups with their status (data gaps) |
| `alert.scored` (1) | scoring | `{alert: Alert, enrichments: EnrichmentResult[], score: ScoreExplanation}` | alerts (writes `score`/`severity` columns), playbooks (trigger matching) | |
| `alert.status_changed` (1) | alerts | `{alertId, from, to, actorId, at}` | metrics (resolution times) | |
| `playbook.run.requested` (1) | playbooks | `{runId, playbookId, version, alertId, dryRun, trigger}` | playbooks executor (enqueue) | |
| `playbook.run.finished` (1) | playbooks | `{runId, playbookId, alertId, status, dryRun, durationMs}` | metrics | |
| `approval.requested` (1) | playbooks | `{approvalId, runId, stepId, approverRole, prompt, expiresAt}` | (console via polling) | |
| `approval.decided` (1) | playbooks | `{approvalId, runId, decision, decidedBy}` | playbooks executor (resume) | |

## Evolution rules

1. **Additive changes only** within a version: new optional fields are fine.
2. A breaking change → bump `version`, publish both versions during migration, and
   make consumers accept both.
3. Never reuse an event type name for a different meaning.
4. Payloads carry **snapshots** (e.g. the full alert), so consumers never need to query
   the producer's tables ([ADR-0002](../adr/0002-hexagonal-modular-monolith.md)). This trades
   payload size for decoupling.
