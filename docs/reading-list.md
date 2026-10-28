# Reading list

The books, papers, articles and talks behind Spine's decisions, grouped by topic. Each
entry lists the ADRs it informed, so you can read the source behind a decision.

## Architecture and design

| Resource                                                                       | Why read it                                  | Informs              |
| ------------------------------------------------------------------------------ | -------------------------------------------- | -------------------- |
| Alistair Cockburn, _Hexagonal Architecture_ (2005, article)                    | The original ports & adapters idea           | ADR-0002             |
| Eric Evans, _Domain-Driven Design_ (2003) — Part IV, Strategic Design          | Bounded contexts, context maps               | ADR-0002             |
| Kamil Grzybek, _Modular Monolith: A Primer_ (2019, blog series)                | Boundaries without microservices             | ADR-0002, 0020       |
| Robert C. Martin, _Clean Architecture_ (2017) — "The Dependency Rule"          | Why dependencies point inward                | ADR-0020             |
| Martin Kleppmann, _Designing Data-Intensive Applications_ (2017) — ch. 7, 11   | Transactions, event logs, exactly-once myths | ADR-0007, 0009, 0010 |
| Chris Richardson, _Microservices Patterns_ (2018) — Transactional Outbox, Saga | Outbox and compensation                      | ADR-0009, 0013       |
| Greg Young, _CQRS Documents_ (2010)                                            | Event sourcing done deliberately             | ADR-0010             |
| Gregor Hohpe & Bobby Woolf, _Enterprise Integration Patterns_ (2003)           | Idempotent receiver, message channels        | ADR-0009             |

## Reliability and operations

| Resource                                                                          | Why read it                           | Informs                   |
| --------------------------------------------------------------------------------- | ------------------------------------- | ------------------------- |
| Michael Nygard, _Release It!_ 2nd ed. (2018) — Stability Patterns                 | Timeouts, circuit breakers, bulkheads | ADR-0014                  |
| Marc Brooker, _Exponential Backoff and Jitter_ (AWS Architecture Blog, 2015)      | Why full jitter                       | ADR-0014                  |
| Google, _Site Reliability Engineering_ (2016) — ch. 6 Monitoring, ch. 21 Overload | Golden signals, load shedding         | ADR-0019, 0024            |
| Google, _The Site Reliability Workbook_ (2018) — Implementing SLOs                | SLOs, percentiles vs means            | ADR-0026, operations/slos |
| Majors, Fong-Jones, Miranda, _Observability Engineering_ (2022)                   | Traces across async boundaries        | ADR-0019                  |
| Adam Wiggins, _The Twelve-Factor App_ (12factor.net)                              | Config, logs, disposability           | config.ts, lifecycle.ts   |

## Security

| Resource                                                        | Why read it               | Informs                     |
| --------------------------------------------------------------- | ------------------------- | --------------------------- |
| OWASP Top 10 (2021) and ASVS 4.0                                | Baseline web app security | security/\*, ADR-0016, 0017 |
| OWASP Password Storage & Session Management Cheat Sheets        | argon2id params, cookies  | ADR-0016                    |
| RFC 8725, _JWT Best Current Practices_                          | Algorithm pinning, claims | ADR-0016                    |
| Adam Shostack, _Threat Modeling: Designing for Security_ (2014) | STRIDE                    | security/threat-model.md    |
| David Bianco, _The Pyramid of Pain_ (2013, blog)                | Value of indicator types  | ADR-0015, domain primer     |
| MITRE ATT&CK (attack.mitre.org)                                 | Tactics and techniques    | ADR-0011                    |
| OCSF schema and Elastic Common Schema docs                      | Event normalization       | ADR-0011                    |

## Testing and engineering practice

| Resource                                                                        | Why read it                          | Informs         |
| ------------------------------------------------------------------------------- | ------------------------------------ | --------------- |
| Winters, Manshreck, Wright, _Software Engineering at Google_ (2020) — ch. 11–14 | Test sizes, code review, deprecation | ADR-0021, 0025  |
| John Hughes, _QuickCheck testing for fun and profit_ (2007, paper)              | Property-based testing               | ADR-0021        |
| Andreas Zeller, _Why Programs Fail_ (2nd ed., 2009)                             | Scientific debugging                 | journal entries |
| Forsgren, Humble, Kim, _Accelerate_ (2018)                                      | Delivery performance and CI          | ADR-0025        |
| Michael Nygard, _Documenting Architecture Decisions_ (2011)                     | ADRs                                 | ADR-0001        |
