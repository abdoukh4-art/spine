# Architecture overview

This page uses the [C4 model](https://c4model.com) (Context → Containers → Components)
to zoom in step by step. Diagrams are Mermaid, so they render on GitHub and are versioned with the code.

## Level 1 — System context

Who and what Spine talks to.

```mermaid
C4Context
  title Spine — system context
  Person(analyst, "SOC analyst", "Triages alerts, approves risky actions")
  Person(admin, "SOC lead / admin", "Authors playbooks & scoring rules, manages users")
  Person(viewer, "Auditor", "Read-only: dashboards, audit log")
  System(spine, "Spine", "SOAR: ingest, enrich, score, respond, measure")
  System_Ext(detectors, "Detection tools", "SIEM, EDR, IDS (Suricata), email gateway")
  System_Ext(intel, "Enrichment providers", "Reputation, geo-IP, asset inventory — SIMULATED with fixtures")
  System_Ext(response, "Response tools", "Firewall, ticketing, chat — SIMULATED adapters")
  System_Ext(obs, "Observability stack", "Prometheus, Grafana, (Jaeger)")
  Rel(detectors, spine, "Alerts", "HTTPS webhooks (HMAC) / batch files")
  Rel(analyst, spine, "Uses", "Browser")
  Rel(admin, spine, "Configures", "Browser")
  Rel(viewer, spine, "Reads", "Browser")
  Rel(spine, intel, "Looks up observables")
  Rel(spine, response, "Blocks, tickets, notifies")
  Rel(obs, spine, "Scrapes metrics")
```

## Level 2 — Containers

The deployable/runnable units ([ADR-0002](../adr/0002-hexagonal-modular-monolith.md), [ADR-0008](../adr/0008-bullmq-redis-job-queue.md)).

```mermaid
C4Container
  title Spine — containers
  Person(analyst, "Analyst")
  System_Ext(detectors, "Detection tools")
  Container_Boundary(spine, "Spine") {
    Container(nginx, "Reverse proxy", "nginx", "TLS termination, static console, /api proxy, security headers")
    Container(console, "Console", "React 19 SPA", "Alert queue, detail, run timeline, approvals, metrics")
    Container(api, "API", "Node 22, Fastify", "REST /api/v1, auth, validation, ingestion, back-pressure")
    Container(worker, "Worker", "Node 22, BullMQ", "Outbox relay, event subscribers, playbook executor")
    ContainerDb(pg, "PostgreSQL 16", "System of record", "Alerts, runs (event-sourced), outbox, audit log")
    ContainerDb(redis, "Redis 7", "Queue backend", "BullMQ jobs, rate-limit counters (re-creatable state only)")
  }
  System_Ext(prom, "Prometheus + Grafana")
  Rel(analyst, nginx, "HTTPS")
  Rel(detectors, nginx, "HTTPS webhooks")
  Rel(nginx, console, "Serves static files")
  Rel(nginx, api, "Proxies /api")
  Rel(api, pg, "SQL (Kysely)")
  Rel(api, redis, "Rate limits")
  Rel(worker, pg, "SQL: outbox, runs")
  Rel(worker, redis, "BullMQ")
  Rel(prom, api, "Scrapes :9464/metrics")
  Rel(prom, worker, "Scrapes :9464/metrics")
```

**Why two processes from one codebase?** HTTP latency must not suffer when playbooks
are busy, and workers scale with queue depth, not with request rate. They share code,
migrations and the composition root (`apps/api/src/composition.ts`), and they differ only in
their entrypoint (`main.ts` vs `worker.ts`).

## Level 3 — Components (inside the API/worker)

```mermaid
flowchart LR
  subgraph edge[HTTP edge — platform/http]
    sec[helmet · CORS · rate limit · access control · problem+json]
  end
  subgraph modules[Business modules — modules/*]
    ing[Ingestion<br/>normalizers · idempotency · dedup]
    al[Alerts/Cases<br/>lifecycle · queue queries]
    en[Enrichment<br/>providers · resilience]
    sc[Scoring<br/>ruleset · explanations]
    pb[Playbooks<br/>DSL · executor · approvals · simulated adapters]
    au[Auth<br/>JWT · refresh rotation · RBAC · audit]
    me[Metrics<br/>MTTD/MTTR · success rate]
  end
  subgraph kernel[Shared kernel — platform/*]
    db[(Kysely DB)]
    ob[Outbox publisher + relay]
    q[BullMQ queues]
    tel[Telemetry]
  end
  subgraph pkgs[Packages — framework-free]
    ss[shared-schema<br/>Zod contracts + predicate interpreter]
    pe[playbook-engine<br/>validation · reducer · executor]
    er[enrichers<br/>interface · resilience · mocks]
  end
  sec --> ing & al & pb & au & me & en & sc
  ing -- alert.ingested --> ob
  ob -- fan-out --> q
  q --> en -- alert.enriched --> ob
  q --> sc -- alert.scored --> ob
  q --> pb
  q --> al
  pb --> pe
  en --> er
  sc --> ss
  pe --> ss
```

Each module is internally hexagonal:

```
modules/<context>/
  domain/        pure rules and types (no framework imports — enforced by dependency-cruiser)
  application/   use cases + port interfaces (what it needs: repositories, gateways, clock)
  adapters/      http routes, postgres repositories, event handlers, external clients
  public-api.ts  the ONLY import surface for other modules
  index.ts       wires adapters into use cases and returns a SpineModule
```

## Cross-cutting views

- [Sequence diagrams](sequences.md): ingestion and playbook execution, step by step.
- [Data model](data-model.md): the ERD and why each index exists.
- [Event catalog](event-catalog.md): every domain event, producer, consumer.
- [API contract](api-contract.md) and the generated [OpenAPI document](openapi.json).

## Quality attributes and how the architecture serves them

| Attribute     | Mechanism                                                                   | Where                                                       |
| ------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Testability   | Pure domain, ports + in-memory fakes, injected clock/ids                    | every `domain/`, `platform/runtime.ts`                      |
| Reliability   | Transactional outbox, idempotent handlers, event-sourced runs, durable jobs | ADR-0009, 0010                                              |
| Resilience    | Timeouts, retry+jitter, circuit breakers, bulkheads, back-pressure          | ADR-0014, 0024                                              |
| Security      | Deny-by-default access policy, RBAC, validation at every edge, audit log    | ADR-0016, 0017, [threat model](../security/threat-model.md) |
| Observability | Correlation IDs across async hops, OTel metrics/traces, structured logs     | ADR-0019                                                    |
| Evolvability  | Module boundaries enforced in CI, versioned events and playbooks            | ADR-0020                                                    |
