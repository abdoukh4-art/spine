# ADR-0002: Hexagonal modular monolith with bounded contexts

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture

## Context and problem statement

Spine has several distinct sub-domains: Ingestion, Enrichment, Scoring, Playbooks,
Alerts/Cases, Auth (with audit) and Metrics. They change for different reasons and at
different rates. For example, enrichment providers churn constantly while the alert
lifecycle hardly moves. We need a structure that:

- keeps those parts from tangling into a "big ball of mud";
- lets us test business rules without a database, a queue or HTTP;
- does not saddle a small team (and a student portfolio) with the operational cost of
  running many services.

## Decision drivers

- **Testability:** the domain logic must be unit-testable in milliseconds.
- **Operational simplicity:** one deployable for the API, plus one worker process from the same codebase.
- **Replaceability:** enrichment providers and response adapters will be swapped.
- **Learnability:** the boundaries must be visible in the folder structure and enforced, not just "by convention".

## Considered options

1. **Modular monolith, each module hexagonal (ports & adapters)**
2. Microservices (one service per bounded context)
3. Classic layered monolith (controllers → services → repositories, organized by layer)
4. Serverless functions per use case

## Decision outcome

**Chosen option: hexagonal modular monolith.**

```
apps/api/src/
  platform/            # shared kernel: config, logging, db, http, event bus, errors (no business rules)
  modules/<context>/
    domain/            # entities, value objects, domain services, domain events. ZERO framework imports.
    application/       # use cases (primary ports) + secondary port interfaces
    adapters/          # http routes, postgres repositories, queue consumers, external clients
    public-api.ts      # the ONLY file other modules may import
    index.ts           # module registration (composition) for the app
```

Rules (enforced by dependency-cruiser, see [ADR-0020](0020-enforce-module-boundaries.md)):

1. `domain/` may import only from `domain/` of the same module and from `@spine/shared-schema` types.
2. `application/` may import from `domain/` and from platform *ports* (interfaces), never from adapters.
3. A module may import another module **only through its `public-api.ts`**.
4. Cross-module workflows go through **domain events** ([ADR-0009](0009-domain-events-transactional-outbox.md)),
   not direct calls, whenever eventual consistency is acceptable.
5. Pure logic that is reusable outside the API (the playbook engine, the enrichers, the
   contract schemas) lives in `packages/*`, so it is framework-free by construction.

Bounded contexts and their ownership:

| Context | Owns (data) | Publishes events | Consumes events |
|---|---|---|---|
| Ingestion | `idempotency_keys`, normalizers | `alert.ingested`, `alert.deduplicated` | — |
| Alerts/Cases | `alerts`, `cases` | `alert.status_changed`, `case.*` | `alert.ingested`, `alert.scored` |
| Enrichment | `alert_enrichments` | `alert.enriched` | `alert.ingested` |
| Scoring | `alert_scores`, ruleset | `alert.scored` | `alert.enriched` |
| Playbooks | `playbooks`, `playbook_runs`, `playbook_run_events`, `approvals` | `playbook.run.*`, `approval.*` | `alert.scored` |
| Auth | `users`, `refresh_tokens`, `audit_log` | `user.*` | — |
| Metrics | read-only projections | — | queries other modules' public APIs |

### Consequences

- 👍 One deploy and one database, with the *boundaries* of microservices. Extracting a
  module into a service later is mostly mechanical: swap in-process events for a broker.
- 👍 Domain tests run with in-memory fakes, so they're fast and deterministic.
- 👎 More files and mapping code (DTO ↔ domain ↔ row) than a CRUD app. We accept this
  for the parts with real rules (scoring, playbooks, ingestion) and keep thin CRUD
  (users, cases) deliberately simpler. Hexagonal is a tool, not a religion.
- 👎 A shared database invites cross-module SQL joins. They're forbidden: a module reads
  another module's data only through its public API.

## Pros and cons of the options

### Microservices
- 👍 Independent deploys and scaling, plus technology freedom.
- 👎 Network failures between every context, distributed transactions, N pipelines, N
  dashboards. Far too much operational cost for the expected load (hundreds of alerts/s)
  and team size. A well-known anti-pattern is to "start with microservices before you
  know your boundaries".

### Layered monolith
- 👍 Familiar and quick to start.
- 👎 Organized by technical layer, so one feature touches every folder, and nothing
  stops `AlertService` from calling `UserRepository`. Boundaries erode.

### Serverless
- 👍 No servers to manage.
- 👎 Durable playbook execution, long-lived workers and local offline development are all
  awkward. Vendor lock-in conflicts with "self-hostable".

## What would make us revisit this

- One context needs a different scaling profile, e.g. ingestion needs 20× the
  instances of everything else. Then extract Ingestion first, since it's already isolated
  behind events.
- Several teams need independent release cadences.
- Build or test time of the monolith exceeds ~10 minutes in CI.

## Further reading

- Alistair Cockburn, *Hexagonal Architecture* (2005)
- Simon Brown, *Modular Monoliths* (talk, 2018)
- Kamil Grzybek, *Modular Monolith: A Primer* (2019)
- Eric Evans, *Domain-Driven Design* (2003), chapters on Bounded Context and Context Map
- Shopify Engineering, *Deconstructing the Monolith* (2019)
