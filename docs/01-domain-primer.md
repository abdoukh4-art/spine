# 01 — Domain primer: security operations for software engineers

> Who this is for: you can code, but you've never worked in a Security Operations Center.
> After reading this (≈ 20 minutes) every word in Spine's code and docs should make sense.
> Terms in **bold** are defined in the [glossary](glossary.md).

## 1. The SOC and its daily problem

A **Security Operations Center (SOC)** is the team that watches an organization's systems
for attacks and responds to them. Its inputs are **alerts**: machine-generated signals that
something suspicious happened.

```
  endpoints ─┐
  network   ─┼─▶ detection tools (EDR, IDS, email gateway, cloud audit) ─▶ ALERTS ─▶ analysts
  cloud     ─┤                                                                      │
  email     ─┘                                                                      ▼
                                                                         triage → investigate → respond
```

A mid-size company can generate **thousands of alerts per day**. Most are benign
(_false positives_), a few are real. The analyst's job is to find the real ones fast and
act. The pain points:

- **Alert fatigue.** Humans stop paying attention when 95 % of what they see is noise.
- **Swivel-chair work.** Copy an IP from tool A, paste it into tools B, C and D, then write a ticket in tool E.
- **Inconsistent handling.** Two analysts respond to the same alert type differently.
- **Lost knowledge.** "How do we handle a phishing click?" lives in someone's head.

## 2. SIEM vs SOAR (and where Spine fits)

|                | SIEM (Security Information and Event Management) | SOAR (Security Orchestration, Automation and Response)                     |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| Input          | Raw logs and events (billions)                   | Alerts (thousands)                                                         |
| Core job       | Store, search, **correlate** events into alerts  | **Triage, enrich, decide, act** on alerts                                  |
| Typical output | "Rule X fired: 5 failed logins then a success"   | "Enriched, scored 87, approved by Dana, IP blocked, ticket SOC-123 opened" |
| Examples       | Splunk ES, Microsoft Sentinel, Elastic Security  | Splunk SOAR, Cortex XSOAR, Tines, Torq                                     |

**Spine is a SOAR.** It sits _after_ the SIEM/EDR: it receives their alerts and automates
what an analyst would do next. Explicitly _not_ a SIEM; see the non-goals in the [vision](00-vision.md).

- **Orchestration**: talk to many tools through one interface (Spine's enrichers and adapters).
- **Automation**: encode response procedures as **playbooks** (Spine's playbook engine).
- **Response**: take actions such as block, ticket or notify, with approvals and an audit trail (simulated in Spine).

## 3. From event to incident: the chain

```
event ──▶ alert ──▶ (deduplicated) ──▶ enriched alert ──▶ scored alert ──▶ triaged ──▶ incident/case ──▶ response ──▶ closed
  ▲          ▲              ▲                  ▲                 ▲              ▲             ▲              ▲
 log line  detection     Spine            Spine enrichment   Spine scoring   analyst      analyst/case   playbook
           rule fires    ingestion                                                        grouping      + approvals
```

- **Event**: a single observation, such as "process `powershell.exe` started with encoded arguments".
- **Alert**: a detection rule decided an event (or a set of them) is suspicious.
- **Deduplication**: the same detection firing every 5 minutes should be _one_ alert with
  a counter ([ADR-0012](adr/0012-idempotency-and-deduplication.md)).
- **Enrichment**: add context the alert doesn't carry. Is that IP known-bad? Where is it?
  Whose laptop is `FIN-WS-042`, and how critical is it?
- **Scoring/prioritization**: combine severity and context into a number analysts can sort by ([ADR-0015](adr/0015-explainable-rule-based-scoring.md)).
- **Triage**: a human (or automation) decides whether it's real, noise, or needs investigation.
- **Incident / case**: one or more related alerts that represent an actual security issue.
- **Response**: contain (block, isolate), eradicate, recover, and notify people.
- **Closure**: `resolved` (true positive, handled) or `false_positive`.

## 4. Indicators of Compromise (IOCs) and observables

An **observable** is any value in an alert that can be looked up: IP address, domain,
URL, file hash, email address, username, hostname. When an observable is _known to be
malicious_, it's an **Indicator of Compromise (IOC)**.

David Bianco's **Pyramid of Pain** ranks indicators by how much it hurts an attacker
when defenders block them:

```
          ▲  TTPs (behaviour)          ← very hard for attackers to change
         ▲▲  Tools
        ▲▲▲  Network/host artifacts
       ▲▲▲▲  Domain names
      ▲▲▲▲▲  IP addresses
     ▲▲▲▲▲▲  Hash values                ← trivial to change (recompile, new IP)
```

That's why Spine's scoring can't rely on IP reputation alone, and why mapping to
**TTPs** through MITRE ATT&CK matters.

## 5. MITRE ATT&CK in 3 minutes

[MITRE ATT&CK](https://attack.mitre.org) is a public knowledge base of adversary behaviour:

- **Tactics** (the _why_, IDs like `TA0006`): the attacker's goal at a stage, e.g.
  _Initial Access_ (TA0001), _Execution_ (TA0002), _Credential Access_ (TA0006),
  _Lateral Movement_ (TA0008), _Exfiltration_ (TA0010), _Command and Control_ (TA0011).
- **Techniques** (the _how_, IDs like `T1003`): a specific way to reach the goal, e.g.
  _OS Credential Dumping_ (T1003).
- **Sub-techniques** (`T1003.001`, _LSASS Memory_): more specific variants.

Detection rules are usually tagged with techniques. Spine keeps that mapping in every
alert (`mitre[]`), so scoring rules can say "credential access is worse than discovery",
and analysts can filter the queue by technique.

## 6. Measuring a SOC: MTTD and MTTR

- **MTTD — Mean Time To Detect**: how long between the malicious activity and the SOC knowing about it.
- **MTTR — Mean Time To Respond/Resolve**: how long between the SOC knowing about it and the issue being handled.

These terms are used loosely across the industry. Spine defines them **precisely** in
[ADR-0026](adr/0026-mttd-mttr-definitions.md) (MTTD = `receivedAt − occurredAt`,
MTTR = `resolvedAt − receivedAt`) and reports median and p90 next to the mean, because a
handful of forgotten alerts can dominate an average.

A SOAR mainly improves **MTTR**, by doing in seconds what took an analyst 20 minutes. It
can improve **MTTD** indirectly, by reducing the noise that hides real alerts.

## 7. Playbooks (a.k.a. runbooks)

A **playbook** is a documented, repeatable response procedure. In Spine it's a validated
graph of steps ([ADR-0013](adr/0013-playbook-dsl.md)):

```
enrich ─▶ branch(score ≥ 85?) ──yes──▶ approval(analyst) ──approve──▶ block IP ─▶ ticket ─▶ notify
                       └──no──────────────────────────────────────────────────────────────▶ notify
```

Key ideas you'll meet in the code:

- **Human-in-the-loop**: risky actions (blocking) wait for an **approval gate**.
- **Dry run**: execute the logic but not the actions, to test a playbook safely.
- **Compensation**: if a later step fails, undo earlier ones (unblock the IP), much like
  a database transaction rollback but for external side effects. This is the _saga_ pattern.
- **Durable execution**: a playbook can wait hours for an approval and must survive a
  server restart, so its progress is persisted as events ([ADR-0010](adr/0010-event-sourcing-for-playbook-runs-only.md)).

## 8. Alert formats you'll see in `fixtures/`

- **Suricata EVE JSON**: output of the open-source Suricata network IDS. Each line is a
  JSON object; `event_type: "alert"` lines carry `alert.signature`, `alert.severity` (1 = high),
  `src_ip`, `dest_ip` and so on.
- **CEF (Common Event Format)** over syslog: a pipe-delimited header plus key=value extensions, e.g.
  `CEF:0|Vendor|Product|1.0|100|Brute force|7|src=203.0.113.5 dst=10.0.0.8 suser=alice`.
- **Canonical JSON**: Spine's own format, for tools that can POST it directly.

The ingestion module turns all of these into one canonical shape ([ADR-0011](adr/0011-canonical-alert-schema.md)).

## 9. Where to go next

- The [learning path](README.md#suggested-learning-path) in the docs index.
- [Architecture overview](architecture/README.md): how Spine implements all of the above.
- [Glossary](glossary.md).
