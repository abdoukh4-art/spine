# Module guides

Each guide covers purpose, design, public API, invariants, failure modes, how to extend
the module, and exercises (solutions are in [exercises/](exercises/README.md), kept separate on purpose).

| Module         | Bounded context                       | Guide                          |
| -------------- | ------------------------------------- | ------------------------------ |
| Ingestion      | Normalize, deduplicate, accept alerts | [ingestion.md](ingestion.md)   |
| Alerts & cases | Alert lifecycle, queue queries, cases | [alerts.md](alerts.md)         |
| Enrichment     | Providers + resilience                | [enrichment.md](enrichment.md) |
| Scoring        | Explainable rule engine               | [scoring.md](scoring.md)       |
| Playbooks      | DSL, durable executor, approvals      | [playbooks.md](playbooks.md)   |
| Auth           | Users, tokens, RBAC, audit            | [auth.md](auth.md)             |
| Metrics        | MTTD/MTTR, success rates              | [metrics.md](metrics.md)       |
| Console        | Analyst UI                            | [console.md](console.md)       |
