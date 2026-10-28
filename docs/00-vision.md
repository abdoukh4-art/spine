# 00 — Vision

> **Status:** accepted · **Owner:** project maintainers · **Last reviewed:** 2026-10-28

## 1. The problem

A Security Operations Center (SOC) gets thousands of alerts a day from many tools:
EDR agents, network IDS, email gateways, cloud audit logs, SIEM correlation rules.
Each tool uses its own format, its own idea of severity and its own vocabulary.
Analysts lose most of their time on work that is **repetitive and mechanical**:

1. Copy an IP or file hash out of an alert.
2. Paste it into three reputation and geo-location tools.
3. Look up which asset the host is and who owns it.
4. Decide how bad the alert is, based mostly on gut feeling.
5. Open a ticket, post in the team chat, maybe block the indicator on the firewall.
6. Write down what they did so the next shift knows.

This causes **alert fatigue**. Real incidents sit in the queue behind noise, the
*Mean Time To Detect* (MTTD) and *Mean Time To Respond* (MTTR) both grow, and the
knowledge of how to handle each alert type stays in senior analysts' heads.

**SOAR** (Security Orchestration, Automation and Response) platforms tackle this. They
*orchestrate* tools behind one interface, *automate* the repetitive steps as
**playbooks**, and keep a full record of every *response* for audit and learning.

## 2. What Spine is

Spine is an **open-source, self-hostable, teaching-grade SOAR platform**. It:

- **ingests** alerts from REST, webhooks and batch files, and turns every source into one
  canonical alert schema (inspired by ECS/OCSF) with MITRE ATT&CK mapping, deduplication
  and idempotency;
- **enriches** each alert's indicators through pluggable providers protected by timeouts,
  retries, circuit breakers and bulkheads;
- **scores** each alert with a transparent, rule-based engine in which *every point of the
  score can be explained*;
- **responds** by running versioned, validated **playbooks**: DAGs of steps with
  branching, approval gates, retries, compensation, dry-run mode and durable execution
  that survives crashes. Every response action goes through simulated adapters;
- **measures** itself: MTTD, MTTR, alert volume, playbook success rate and latency;
- **teaches**: every decision is recorded in an ADR, every module has a learning guide,
  and the engineering journal shows the mistakes along with the successes.

The name: the spine is what holds a body upright and carries the signals between the
brain and the limbs. A SOAR platform plays that role between detection tools (the
senses) and response tools (the limbs).

## 3. Users

| Persona | Role in Spine | What they need |
|---|---|---|
| **Tier-1 SOC analyst** | `analyst` | A prioritized queue, enrichment already done, a score they can trust *because it's explained*, one-click approvals. |
| **Tier-2/3 analyst / incident responder** | `analyst` | Playbook run timelines, case management, the ability to re-run with dry-run. |
| **SOC lead / detection engineer** | `admin` | Author and version playbooks and scoring rules, see MTTD/MTTR trends, manage users. |
| **Auditor / manager** | `viewer` | Read-only dashboards and an immutable audit trail. |
| **Learner** (secondary, but first-class) | — | Readable code, ADRs, tutorials, exercises. |

## 4. Goals

1. **G1 — One canonical alert.** Any supported source is normalized into one schema with
   ATT&CK mapping, so everything downstream deals with a single shape.
2. **G2 — Explainability over magic.** Every score lists its contributing factors, and
   every playbook decision is visible in a timeline.
3. **G3 — Safe automation.** Responses are simulated, approval-gated where risky,
   reversible through compensation, and fully audited.
4. **G4 — Resilience.** A slow or failing enrichment provider must never take ingestion
   down. A worker crash must never lose or duplicate a playbook action.
5. **G5 — Operability.** One-command demo, health and readiness endpoints, structured logs
   with correlation IDs, traces, metrics and dashboards.
6. **G6 — Learnability.** A newcomer can follow every design choice from first principles.

## 5. Non-goals (explicit)

- **Not a SIEM.** Spine does not store or search raw logs at scale, and it does not run
  correlation rules over event streams. It consumes *alerts* that a SIEM or EDR produced.
- **No real response actions.** Firewall, ticketing and chat integrations are
  **simulated**. Spine never ships offensive or destructive capability.
- **No real third-party API calls.** Enrichment providers are mocks driven by fixtures,
  so everything runs offline.
- **Not multi-tenant** in v0.1. It runs as a single organization.
- **No ML-based scoring** in v0.1. Rule-based scoring is chosen on purpose for
  explainability ([ADR-0015](adr/0015-explainable-rule-based-scoring.md)).
- **No horizontal-scale guarantees** beyond what one Postgres and one Redis can handle.

## 6. Success metrics

| # | Metric | Target for v0.1 | How it is measured |
|---|---|---|---|
| S1 | End-to-end demo works from a clean clone | `make demo` completes with no manual steps | CI job + manual check |
| S2 | Ingest → scored latency (p95, local) | < 500 ms with mock enrichers | k6 load test ([docs/operations/performance.md](operations/performance.md)) |
| S3 | Ingestion throughput (single API instance) | ≥ 200 alerts/s sustained with back-pressure, no errors | k6 |
| S4 | Domain + playbook-engine test coverage | ≥ 85 % lines | Vitest coverage report in CI |
| S5 | Score explainability | 100 % of scores have ≥ 1 factor or an explicit "no rules matched" factor | property-based test |
| S6 | Playbook durability | A run killed mid-step resumes and never repeats a completed action | integration test |
| S7 | Security hygiene | 0 high/critical findings from CodeQL, Trivy, npm audit at release | CI security workflow |
| S8 | Learnability | Every ADR has "options considered" and "revisit when"; every module has exercises | docs lint + review |

## 7. Guiding principles

1. **Write the "why" down.** If there was a choice, there is an ADR.
2. **The domain core is boring TypeScript.** No framework imports, so it can be tested
   in milliseconds.
3. **Contracts first.** Zod schemas in `packages/shared-schema` are the single source of
   truth for the API, the console and the OpenAPI document.
4. **Fail loudly in development, degrade gracefully in production.**
5. **Report reality.** Docs never claim that something works unless a test or a recorded
   run shows it.

## 8. Related reading

- [01 — Domain primer](01-domain-primer.md): SOC, SIEM vs SOAR, MTTD/MTTR, IOCs, ATT&CK.
- [ADR index](adr/README.md)
- [Architecture overview](architecture/README.md)
