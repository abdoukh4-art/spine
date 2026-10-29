# Spine documentation hub

Spine is a working SOAR platform **and** a learning resource. Every decision has a
written "why". This page is the map.

## Suggested learning path

| Step | Read                                                                                                                                                                                                                                                                  | You will understand                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | [00 — Vision](00-vision.md)                                                                                                                                                                                                                                           | What problem Spine solves, for whom, and what it deliberately doesn't do |
| 2    | [01 — Domain primer](01-domain-primer.md) + [Glossary](glossary.md)                                                                                                                                                                                                   | SOC, SIEM vs SOAR, alerts → incidents, IOCs, ATT&CK, MTTD/MTTR           |
| 3    | [Architecture overview](architecture/README.md) (C4 diagrams)                                                                                                                                                                                                         | The big picture: containers, modules, data flow                          |
| 4    | [ADR-0002](adr/0002-hexagonal-modular-monolith.md), [0009](adr/0009-domain-events-transactional-outbox.md), [0010](adr/0010-event-sourcing-for-playbook-runs-only.md)                                                                                                 | Why a modular monolith, how modules talk, where event sourcing is used   |
| 5    | [Sequence diagrams](architecture/sequences.md)                                                                                                                                                                                                                        | Follow one alert from webhook to firewall block                          |
| 6    | Module guides, in pipeline order: [ingestion](modules/ingestion.md) → [enrichment](modules/enrichment.md) → [scoring](modules/scoring.md) → [playbooks](modules/playbooks.md) → [alerts](modules/alerts.md) → [auth](modules/auth.md) → [metrics](modules/metrics.md) | Each module's design, invariants, failure modes, plus exercises          |
| 7    | [Tutorials](tutorials/README.md)                                                                                                                                                                                                                                      | Build a scoring rule, an enricher, and a playbook step yourself          |
| 8    | [Testing strategy](testing/strategy.md)                                                                                                                                                                                                                               | How confidence is built: unit → property → integration → contract → e2e  |
| 9    | [Security](security/README.md)                                                                                                                                                                                                                                        | Threat model (STRIDE), RBAC, OWASP mapping                               |
| 10   | [Operations](operations/README.md)                                                                                                                                                                                                                                    | Running it: runbooks, SLOs, backup/restore, upgrades, performance        |
| 11   | [Engineering journal](journal/README.md)                                                                                                                                                                                                                              | What went wrong along the way and how it was debugged                    |

## Reference

- [Architecture Decision Records (index)](adr/README.md)
- [API contract](architecture/api-contract.md) · [OpenAPI document](architecture/openapi.json)
- [Data model (ERD)](architecture/data-model.md) · [Event catalog](architecture/event-catalog.md)
- [Reading list](reading-list.md): the books, papers and talks behind the decisions
- [Project status](STATUS.md): what's done, stubbed and known-broken

## Conventions for these docs

- A PR that changes behaviour updates the docs **in the same PR**. CI runs
  `pnpm docs:check` (broken links, ADR index, package READMEs, module docs).
- Write for a smart newcomer: define a term at first use or link the glossary.
- Never claim something works without a test or a recorded run. The journal and STATUS
  record failures honestly.
