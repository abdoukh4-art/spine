# Sequence diagrams

## 1. Ingestion: webhook → scored alert

```mermaid
sequenceDiagram
  autonumber
  participant S as Suricata (webhook sender)
  participant API as API (Fastify)
  participant ING as Ingestion module
  participant DB as PostgreSQL
  participant R as Outbox relay (worker)
  participant Q as BullMQ (spine-events)
  participant EN as Enrichment handler
  participant SC as Scoring handler
  participant AL as Alerts projection
  participant PB as Playbook trigger

  S->>API: POST /api/v1/ingest/webhooks/suricata<br/>X-Spine-Timestamp, X-Spine-Signature
  API->>API: rate limit · back-pressure check (outbox backlog)
  API->>ING: verify HMAC (constant-time, ±5 min)
  ING->>ING: normalize (suricata-eve → CanonicalAlert)<br/>extract + normalize indicators<br/>compute fingerprint
  ING->>DB: BEGIN
  ING->>DB: find OPEN alert by fingerprint
  alt duplicate of an open alert
    ING->>DB: UPDATE duplicate_count+1, last_seen_at
    ING->>DB: INSERT domain_events(alert.deduplicated)
  else new
    ING->>DB: INSERT alerts (unique partial index guards races)
    ING->>DB: INSERT domain_events(alert.ingested, traceparent)
  end
  ING->>DB: COMMIT
  API-->>S: 202 {alertId, status}

  loop every 200 ms
    R->>DB: SELECT … WHERE dispatched_at IS NULL FOR UPDATE SKIP LOCKED
    R->>Q: addBulk(one job per subscriber, jobId=eventId__subscriber)
    R->>DB: UPDATE dispatched_at = now()
  end

  Q->>EN: alert.ingested
  EN->>EN: per indicator × provider:<br/>bulkhead → breaker → retry(jitter) → timeout
  EN->>DB: UPSERT alert_enrichments + INSERT alert.enriched (one tx)
  Q->>SC: alert.enriched
  SC->>SC: baseline(severity) + Σ matching rules → explanation
  SC->>DB: UPSERT alert_scores + INSERT alert.scored (one tx)
  Q->>AL: alert.scored → UPDATE alerts SET score, severity
  Q->>PB: alert.scored → match triggers → create run(s) (unique per playbook+alert)
```

**Failure walk-through** (a good exercise is to find the line for each):

- The API crashes after COMMIT but before responding → the client retries with the same
  `Idempotency-Key` → the stored response is replayed. No duplicate alert.
- The relay crashes after `addBulk` but before `UPDATE dispatched_at` → re-dispatch on
  restart → BullMQ ignores the duplicate job IDs.
- A reputation provider is down → its breaker opens → results with `circuit_open` →
  scoring proceeds, and the explanation lists the data gap.

## 2. Playbook execution with an approval gate and a crash

```mermaid
sequenceDiagram
  autonumber
  participant T as Trigger handler
  participant DB as PostgreSQL (runs + run_events)
  participant Q as BullMQ (spine-playbook-runs)
  participant X as Executor (worker)
  participant E as playbook-engine (pure)
  participant FW as Simulated firewall
  participant A as Analyst (console)
  participant API as API

  T->>DB: INSERT playbook_runs(pending) + run.requested event
  T->>Q: add {runId} (jobId=run__id__0)
  Q->>X: job {runId}
  X->>DB: load definition (pinned version) + events
  X->>E: reduce(events) → state
  E-->>X: next action = execute step "enrich"
  X->>DB: append step.started(seq=n) — optimistic (run_id, seq) PK
  X->>X: call handler with timeout
  X->>DB: append step.succeeded(output)
  X->>E: next action
  E-->>X: approval required at "approve-block"
  X->>DB: append approval.requested + INSERT approvals(pending)
  Note over X,DB: run status = waiting_approval. The worker is free and nothing is held in memory.
  A->>API: POST /approvals/{id}/decision {approve}
  API->>DB: UPDATE approvals SET approved + append approval.granted + audit entry
  API->>Q: add {runId} (jobId=run__id__seq)
  Q->>X: job {runId}
  X->>E: reduce(events) → next = "block"
  X->>DB: append step.started(block)
  X->>FW: block(203.0.113.7, idempotencyKey=runId:block)
  Note over X: 💥 worker crashes here
  Q->>X: job retried after stalled-job detection
  X->>E: reduce(events): "block" started, not finished → retry it
  X->>FW: block(…, same idempotencyKey) → returns the original result, no second block
  X->>DB: append step.succeeded(block)
  X->>DB: … ticket, notify … append run.succeeded + update projection
```

The key properties shown here: **state is never held in memory between steps**, every side
effect carries an **idempotency key derived from (runId, stepId)**, and the engine decides
the next action from the event log alone (a pure function, so it can be property-tested).
