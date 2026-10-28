# Operations

Everything needed to run Spine in production-like conditions: deploy it, see what it is
doing, know when it is unhealthy, recover from failures and change it safely.

| Document                                | Purpose                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Deployment](deployment.md)             | Docker Compose stack, images, nginx/TLS, systemd units, configuration reference, checklist                    |
| [Observability](observability.md)       | Metrics, traces and logs; metric catalogue and naming as verified; trace propagation; dashboard               |
| [SLOs and alerting](slos.md)            | SLIs/SLOs, error budgets, multi-window burn-rate alerts, cause-based alerts                                   |
| [Runbooks](runbooks.md)                 | Step-by-step responses: outbox backlog, circuit open, stuck runs, DB down, Redis wiped, 429 storms, disk full |
| [Backup and restore](backup-restore.md) | What to back up, `pg_dump`/`pg_restore` procedure and a recorded, tested drill                                |
| [Upgrades](upgrade.md)                  | Image tags, forward-only migrations, expand/contract, rollback = roll forward                                 |
| [Performance](performance.md)           | k6 load-test method (open workload, outcome classes) and measured results                                     |

Related decisions: [ADR-0019](../adr/0019-observability-otel-pino-prometheus.md) (observability),
[ADR-0080](../adr/0080-telemetry-bootstrap-and-metric-conventions.md) (telemetry bootstrap),
[ADR-0081](../adr/0081-container-images-distroless-single-image.md) (images),
[ADR-0082](../adr/0082-nginx-edge-proxy.md) (nginx edge),
[ADR-0083](../adr/0083-single-host-deployment-compose-and-systemd.md) (deployment),
[ADR-0084](../adr/0084-slos-and-burn-rate-alerting.md) (SLOs),
[ADR-0085](../adr/0085-image-scanning-and-sbom-in-ci.md) (image scanning).

Quick start: `make up`, then open http://localhost:8080 (console), http://localhost:3001
(Grafana) and http://localhost:9090 (Prometheus).
