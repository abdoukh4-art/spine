# ADR-0083: Single-host deployment: hardened Docker Compose, with systemd units as the alternative

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** infra + observability workstream
- **Tags:** ops, security

## Context and problem statement

Spine's target is a laptop demo and a small single-server installation, not a cluster
(docs/00-vision.md). We need one way to run the whole stack with one command, and a
documented path for running the Node processes directly on a VM. Both must be secure by
default.

## Decision drivers

- `make up` works from a clean clone (vision success criterion S1).
- Defence in depth: a compromised container gets as little as possible.
- Twelve-factor: config from the environment, logs to stdout, disposable processes.
- Nothing exposed to the network unless asked.

## Considered options

1. **Docker Compose with per-service hardening + systemd units for VM installs**
2. Kubernetes manifests / Helm chart
3. Compose only

## Decision outcome

**Chosen option 1.**

**Compose (`infra/docker-compose.yml`):**

- Every service: `read_only: true` (tmpfs for scratch paths), `cap_drop: [ALL]`,
  `no-new-privileges`, a memory limit, `restart: unless-stopped`, a healthcheck, and
  `depends_on: condition: service_healthy` for start order (Postgres/Redis → API, which
  applies migrations → worker, nginx, Prometheus → Grafana).
- Postgres and Redis run as their image's unprivileged user (`user:`) so their entrypoints
  need no capabilities at all.
- Published ports bind to `SPINE_BIND_ADDRESS` (default `127.0.0.1`).
- **Redis: `appendonly no`, default RDB snapshots, `noeviction`.** Redis holds only state
  we can rebuild (ADR-0008): playbook runs are re-enqueued by the reconciler, and recent
  outbox events can be re-dispatched (runbook "Redis wiped"). An fsync'ed AOF would add
  write latency to protect data whose source of truth is Postgres. `noeviction` is
  mandatory for BullMQ: an evicted job key is silently lost work.
- Grafana: anonymous access off, sign-up off, admin password required from `.env`,
  datasource and dashboard provisioned from files. Jaeger is an opt-in profile (`tracing`).
- `env_file: ../.env` feeds the API and worker, as the twelve-factor model expects.
  Compose overrides the connection URLs with in-network hostnames.

**systemd (`infra/systemd/*.service`):** a dedicated `spine` user, `EnvironmentFile=`,
`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, empty
`CapabilityBoundingSet`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, a system-call
filter, `MemoryMax`, `Restart=on-failure` with a start-limit, and `TimeoutStopSec=30s`
(above the 15 s `SHUTDOWN_TIMEOUT_MS`, so systemd never kills a draining process).
`systemd-analyze security` rates the API unit **1.3 OK**.

### Consequences

- 👍 One command for the full stack, including monitoring; secure defaults.
- 👍 The VM path uses the same build output and the same environment variables.
- 👎 `env_file` hands every `.env` variable to the API and worker containers, including
  ones they don't need (e.g. the Grafana admin password). Acceptable on a single trusted
  host; a multi-tenant deployment should use per-service secrets.
- 👎 Single host = single point of failure. Backups (backup-restore.md) are the recovery
  strategy, not replicas.
- ⚖️ Compose runs with `NODE_ENV` from `.env` (development by default, which enables the
  Swagger UI); production sets `NODE_ENV=production` and real secrets.

## Pros and cons of the options

### Kubernetes / Helm

- 👍 The industry standard for multi-node deployments.
- 👎 A cluster to run for a demo; hides the fundamentals this project teaches. The image,
  probes and config model are already Kubernetes-ready.

### Compose only

- 👍 Less to document.
- 👎 Many small installations run on a plain VM with a managed Postgres; systemd is the
  natural supervisor there.

## What would make us revisit this

- More than one API/worker replica or a high-availability requirement → Kubernetes manifests.
- Redis starts holding state that is not re-creatable → enable AOF (`appendfsync everysec`).

## Further reading

- Docker docs, _Compose file reference_ (`read_only`, `cap_drop`, `security_opt`, healthchecks)
- `systemd.exec(5)` sandboxing options; `systemd-analyze security`
- Redis docs, _Persistence_; BullMQ docs, _Going to production_ (`maxmemory-policy noeviction`)
