# Spine

**An open-source, teaching-grade SOAR platform** (Security Orchestration, Automation and Response).
Spine ingests alerts from detection tools, enriches and scores them with explainable rules,
and runs durable, approval-gated response playbooks through simulated integrations. Every
design decision is documented so you can learn how a real system is engineered.

> 🚧 **Work in progress.** See [docs/STATUS.md](docs/STATUS.md) for what's done, what's stubbed and known issues.

## Why Spine?

- **One canonical alert** from Suricata EVE, CEF/syslog, webhooks or REST, with MITRE ATT&CK mapping, idempotency and deduplication.
- **Explainable scoring.** Every point of every score is traced to a rule.
- **Durable playbooks.** A YAML DAG with branches, approval gates, retries, compensation and dry-run, which survives worker crashes (event-sourced).
- **Resilient enrichment.** Timeouts, retries with jitter, circuit breakers and bulkheads.
- **Safe by design.** All response actions are simulated, and a deny-by-default RBAC + audit log covers everything else.
- **A learning hub.** 27+ ADRs, C4 diagrams, module guides with exercises, tutorials, and an honest engineering journal.

## Start here

- 📚 **[Documentation hub and learning path](docs/README.md)**
- 🎯 [Vision](docs/00-vision.md) · 🛡️ [Domain primer](docs/01-domain-primer.md) · 🏗️ [Architecture](docs/architecture/README.md) · 📝 [ADRs](docs/adr/README.md)

## Quickstart (development)

```bash
corepack enable && pnpm install
cp .env.example .env
pnpm test                 # unit + property tests, no Docker needed
pnpm test:integration     # real Postgres + Redis via Testcontainers
```

The full stack (`make up`) and the one-command demo (`make demo`) arrive in Phases 1–2.

## Repository layout

```
apps/api                  Fastify API + BullMQ worker (hexagonal modular monolith)
apps/console              React 19 analyst console
packages/shared-schema    Zod contracts: the single source of truth
packages/playbook-engine  Pure playbook DSL + durable executor
packages/enrichers        Enricher interface, resilience primitives, mock providers
docs/                     Vision, ADRs, architecture, modules, security, operations, journal
infra/                    Docker, Compose, nginx, Prometheus, Grafana
```

## License

[MIT](LICENSE). Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
