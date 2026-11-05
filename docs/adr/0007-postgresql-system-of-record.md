# ADR-0007: PostgreSQL 16 as the single system of record

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** data

## Context and problem statement

Spine stores alerts (semi-structured, with a raw payload), relational data (users, cases,
approvals), an append-only playbook run history, an outbox of domain events, and
idempotency records. We want as few stateful systems as possible to operate and back up.

## Decision drivers

- ACID transactions across the state change and the event outbox.
- Semi-structured storage for raw alerts and enrichment payloads.
- Queue-like reads (`FOR UPDATE SKIP LOCKED`) for the outbox relay.
- Familiar operations: backup/restore, `pg_dump`, managed offerings everywhere.

## Considered options

1. **PostgreSQL 16** (relational + `jsonb`)
2. MongoDB (document store)
3. Elasticsearch / OpenSearch as primary store (search-first, like many SIEMs)
4. PostgreSQL + Elasticsearch side by side

## Decision outcome

**Chosen option: PostgreSQL 16 only.** Raw alert payloads and enrichment data go in
`jsonb` columns. Filterable fields (status, severity, score, received_at, fingerprint) are
real columns with B-tree indexes. Free-text search over titles uses a `pg_trgm` GIN index.

Redis is used **only** as the BullMQ queue backend ([ADR-0008](0008-bullmq-redis-job-queue.md)).
It is never a system of record: losing Redis loses in-flight jobs, which are rebuilt from
Postgres on startup (the run table is authoritative).

### Consequences

- 👍 One transactional store, one backup procedure, one set of credentials.
- 👍 Constraints (unique fingerprints, foreign keys, CHECKs on enums) catch bugs early.
- 👎 Full-text search is weaker than Elasticsearch. Acceptable, because Spine is not a SIEM (see non-goals in [00-vision](../00-vision.md)).
- 👎 Very high alert volumes (> 10 M rows/month) will need partitioning by `received_at`. Documented in the roadmap.

## Pros and cons of the options

### MongoDB

- 👍 Natural for the raw JSON payloads.
- 👎 Weaker multi-document transactions for the outbox pattern. Relational parts (RBAC,
  approvals) are awkward. A second paradigm for learners.

### Elasticsearch as primary

- 👍 Superb search and aggregations.
- 👎 Not a transactional store, operationally heavy, and licensing complexity.

### Postgres + Elasticsearch

- 👍 Best of both.
- 👎 Two systems to sync (dual-write problems), which is overkill for v0.1.

## What would make us revisit this

- Analysts need sub-second free-text search across more than 50 M alerts.
- Write throughput saturates a single primary even with partitioning.

## Further reading

- PostgreSQL docs: _JSON Types_, _SELECT … FOR UPDATE SKIP LOCKED_, _pg_trgm_
- Martin Kleppmann, _Designing Data-Intensive Applications_, ch. 2 & 7
