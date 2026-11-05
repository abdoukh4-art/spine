# Glossary

Security terms first, then engineering terms. Links point to where Spine uses the concept.

## Security operations

| Term                      | Definition                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Alert**                 | A signal from a detection tool that something suspicious happened. Spine's unit of work ([ADR-0011](adr/0011-canonical-alert-schema.md)). |
| **ATT&CK (MITRE)**        | Public knowledge base of adversary tactics (`TA####`) and techniques (`T####[.###]`).                                                     |
| **Case / Incident**       | One or more related alerts representing a real security issue, tracked to closure.                                                        |
| **CEF**                   | Common Event Format: a pipe-delimited syslog alert format (`CEF:0\|vendor\|product\|…`).                                                  |
| **Compensation**          | Undoing a completed step's side effect when a later step fails (the saga pattern).                                                        |
| **Deduplication**         | Merging repeated detections of the same thing into one alert with a counter ([ADR-0012](adr/0012-idempotency-and-deduplication.md)).      |
| **Detection engineering** | Writing and tuning the rules that produce alerts.                                                                                         |
| **ECS**                   | Elastic Common Schema: a field-naming standard for security events.                                                                       |
| **EDR**                   | Endpoint Detection and Response: an agent on laptops/servers that detects malicious behaviour.                                            |
| **Enrichment**            | Adding context to an alert's observables (reputation, geo, asset owner).                                                                  |
| **False positive**        | An alert that fired but isn't malicious.                                                                                                  |
| **IDS**                   | Intrusion Detection System (e.g. Suricata): inspects network traffic.                                                                     |
| **IOC**                   | Indicator of Compromise: an observable known to be malicious.                                                                             |
| **MTTD / MTTR**           | Mean Time To Detect / Respond ([ADR-0026](adr/0026-mttd-mttr-definitions.md)).                                                            |
| **Observable**            | A lookup-able value in an alert: IP, domain, URL, hash, email, user, host.                                                                |
| **OCSF**                  | Open Cybersecurity Schema Framework: a vendor-neutral event schema.                                                                       |
| **Playbook / runbook**    | A codified response procedure ([ADR-0013](adr/0013-playbook-dsl.md)).                                                                     |
| **Pyramid of Pain**       | Ranking of indicator types by how costly they are for attackers to change.                                                                |
| **SIEM**                  | Security Information and Event Management: log storage, search and correlation.                                                           |
| **SOAR**                  | Security Orchestration, Automation and Response: what Spine is.                                                                           |
| **SOC**                   | Security Operations Center.                                                                                                               |
| **Suricata EVE**          | Suricata's JSON output format.                                                                                                            |
| **Tactic / Technique**    | ATT&CK's _why_ / _how_ of an adversary action.                                                                                            |
| **Triage**                | Quickly deciding whether an alert is real, noise, or needs investigation.                                                                 |
| **TTP**                   | Tactics, Techniques and Procedures: attacker behaviour, the top of the Pyramid of Pain.                                                   |

## Engineering

| Term                           | Definition                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR**                        | Architecture Decision Record ([ADR-0001](adr/0001-record-architecture-decisions.md)).                                                              |
| **Adapter**                    | Hexagonal architecture: code that connects a port to a technology (Postgres, HTTP, BullMQ).                                                        |
| **At-least-once delivery**     | A message may be delivered more than once, never zero times. Requires idempotent handlers.                                                         |
| **Back-pressure**              | Refusing or slowing input when downstream can't keep up ([ADR-0024](adr/0024-api-conventions.md)).                                                 |
| **Bounded context**            | DDD: a boundary within which a model and its language are consistent (our modules).                                                                |
| **Bulkhead**                   | Isolating resources (concurrency slots) per dependency so one can't exhaust all ([ADR-0014](adr/0014-hand-written-resilience-primitives.md)).      |
| **Circuit breaker**            | Stops calling a failing dependency for a cool-down period, then probes it.                                                                         |
| **Composition root**           | The single place where dependencies are wired together (`apps/api/src/composition.ts`).                                                            |
| **Contract test**              | Checks that real API responses match the published OpenAPI spec.                                                                                   |
| **Cursor (keyset) pagination** | Paging by "items after this key" instead of `OFFSET`; stable under inserts.                                                                        |
| **Domain event**               | A fact that happened in the domain (`alert.scored`), published for other modules.                                                                  |
| **Durable execution**          | Running a workflow so that it resumes exactly where it was after a crash.                                                                          |
| **Event sourcing**             | Storing the sequence of events and deriving state from them ([ADR-0010](adr/0010-event-sourcing-for-playbook-runs-only.md)).                       |
| **Idempotency**                | Doing an operation twice has the same effect as doing it once.                                                                                     |
| **Jitter**                     | Randomness added to retry delays so clients don't retry in lock-step.                                                                              |
| **Outbox (transactional)**     | Writing events to a table in the same transaction as the state change, relayed later ([ADR-0009](adr/0009-domain-events-transactional-outbox.md)). |
| **Port**                       | Hexagonal architecture: an interface the domain/application defines (what it needs or offers).                                                     |
| **Problem details**            | RFC 9457 JSON error format.                                                                                                                        |
| **Property-based testing**     | Generating many random inputs to check that an invariant always holds (fast-check).                                                                |
| **RBAC**                       | Role-Based Access Control ([ADR-0017](adr/0017-rbac-model.md)).                                                                                    |
| **Saga**                       | A long-running transaction made of steps with compensating actions.                                                                                |
| **SLO**                        | Service Level Objective: a target for a reliability metric.                                                                                        |
| **STRIDE**                     | Threat categories: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege.                            |
| **Twelve-factor app**          | Principles for cloud-native apps (config in env, logs to stdout, disposability…).                                                                  |
