# Deployment

Spine runs as two Node processes (API and worker) from **one image**, behind nginx, with
PostgreSQL 16 and Redis 7. Two supported topologies on a single host
([ADR-0083](../adr/0083-single-host-deployment-compose-and-systemd.md)):

- **Docker Compose** (`infra/docker-compose.yml`): everything, including Prometheus and
  Grafana. The default for demos and small installations.
- **systemd** (`infra/systemd/`): API and worker as hardened services on a VM, with
  Postgres/Redis managed elsewhere.

```mermaid
flowchart LR
  U[Browser / sensors] -- 8080 / 8443 --> N[console: nginx<br/>SPA + reverse proxy + TLS]
  N -- /api, /healthz, /readyz --> A[api :3000]
  A --> PG[(postgres)]
  A --> R[(redis)]
  W[worker] --> PG
  W --> R
  P[prometheus :9090] -- scrape :9464 --> A
  P -- scrape :9464 --> W
  G[grafana :3001] --> P
  A & W -. OTLP, profile tracing .-> J[jaeger :16686]
```

## Docker Compose

```bash
make up        # creates .env from .env.example and a self-signed cert on first run
make logs      # follow api + worker logs
make down      # stop (volumes are kept)
```

`make up` runs `docker compose -f infra/docker-compose.yml --env-file .env up -d --build`.
It builds `spine-api:local` and `spine-console:local`, then starts services in dependency
order using healthchecks: Postgres and Redis → API (applies migrations) → worker, nginx and
Prometheus → Grafana.

| URL                    | What                                         |
| ---------------------- | -------------------------------------------- |
| http://localhost:8080  | Console + API through nginx (plain HTTP)     |
| https://localhost:8443 | Same over TLS (self-signed: browser warning) |
| http://localhost:3000  | API directly (debugging)                     |
| http://localhost:9090  | Prometheus (targets, alerts)                 |
| http://localhost:3001  | Grafana (`admin` / `GRAFANA_ADMIN_PASSWORD`) |
| http://localhost:16686 | Jaeger, with `COMPOSE_PROFILES=tracing`      |

Ports bind to `SPINE_BIND_ADDRESS` (default `127.0.0.1`): nothing is reachable from the
network unless you change it.

### What the compose file enforces

| Control                         | Applied to   | Why                                                         |
| ------------------------------- | ------------ | ----------------------------------------------------------- |
| `read_only: true` + tmpfs       | all services | A compromised process cannot persist or modify binaries     |
| `cap_drop: [ALL]`               | all services | No Linux capabilities (no raw sockets, chown, setuid …)     |
| `no-new-privileges`             | all services | setuid binaries cannot raise privileges                     |
| non-root user                   | all services | Postgres/Redis via `user:`, our images via `USER`           |
| memory limit                    | all services | One leak cannot starve the host                             |
| healthcheck + `service_healthy` | all services | Start order follows readiness, not just "container started" |
| `restart: unless-stopped`       | all services | Crash recovery without restarting what you stopped          |
| log rotation (10 MB × 3)        | all services | stdout logs cannot fill the disk                            |

Redis runs with `appendonly no`, default RDB snapshots and `maxmemory-policy noeviction`
(BullMQ requirement); see ADR-0083 and the [Redis wiped runbook](runbooks.md#redis-wiped).

### Building behind a mirror or a TLS-intercepting proxy

- `DOCKER_REGISTRY=mirror.gcr.io` in `.env` pulls every third-party image from Google's
  Docker Hub mirror (avoids Docker Hub rate limits).
- `BUILD_CA_FILE=./tls/build-ca.crt` (relative to `infra/`) passes your proxy's CA to the
  build as a BuildKit secret; it is never stored in an image layer. Put the file under
  `infra/tls/` (git-ignored): Compose's builder refuses secret files outside the project.
- `APK_UPGRADE=false` only if the Alpine package CDN is unreachable (the console image
  then keeps the base image's packages and the image scan will say so).

### Images

| Image           | Dockerfile                        | Runtime base                                  | Runs as |
| --------------- | --------------------------------- | --------------------------------------------- | ------- |
| `spine-api`     | `infra/docker/api.Dockerfile`     | `gcr.io/distroless/nodejs22-debian13:nonroot` | 65532   |
| `spine-console` | `infra/docker/console.Dockerfile` | `nginxinc/nginx-unprivileged:1.30-alpine`     | 101     |

The API image serves both processes: `CMD ["dist/main.js"]` (API) or
`["dist/worker.js"]` (worker). Health: there is no shell in distroless, so probes are HTTP
(`GET /healthz` = liveness, `GET /readyz` = readiness) or
`node /app/healthcheck.mjs <url>` in Compose. The worker's liveness probe is its metrics
endpoint. See [ADR-0081](../adr/0081-container-images-distroless-single-image.md).

## nginx and TLS

The console image's nginx ([ADR-0082](../adr/0082-nginx-edge-proxy.md)) serves the SPA,
proxies `/api/`, `/healthz`, `/readyz` and `/docs` to the API, and terminates TLS.

Run-time variables (rendered into the config at start):

| Variable             | Default     | Meaning                                                                                |
| -------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `SPINE_API_UPSTREAM` | `api:3000`  | API address; re-resolved every 10 s (`resolve`), so a recreated API container is found |
| `SPINE_SERVER_NAME`  | `localhost` | `server_name`                                                                          |
| `SPINE_HSTS_MAX_AGE` | `0`         | HSTS max-age over TLS. Keep 0 on `localhost`; use `63072000` in production             |
| `SPINE_REAL_IP_FROM` | `127.0.0.1` | Address/CIDR of a load balancer in front of nginx, whose `X-Forwarded-For` is trusted  |

**TLS.** nginx enables the 8443 server only if `/etc/nginx/tls/server.crt` and
`server.key` exist (Compose mounts `infra/tls/`). Locally, `scripts/dev-certs.sh`
(run by `make up`) creates a self-signed P-256 certificate for `localhost`. In production,
mount a real certificate chain (`server.crt` = leaf + intermediates) and key, publish 8443
as 443, set `SPINE_HSTS_MAX_AGE=63072000`, and replace the 8080 server's body with
`return 308 https://$host$request_uri;` (the line is in the template). Protocols are
TLS 1.2 and 1.3 (Mozilla intermediate). OCSP stapling is documented in the template but
off, because several public CAs have retired OCSP.

**Client IPs.** The API runs with `TRUST_PROXY=true` behind nginx. nginx **overwrites**
`X-Forwarded-For` with the client address; if another proxy sits in front, list it in
`SPINE_REAL_IP_FROM` so nginx recovers the real client first. Never expose the API port
directly with `TRUST_PROXY=true`: any client could then choose its own IP.

**Limits.** 1 MiB request bodies (10 MiB on `/api/v1/ingest/batch`), 10 logins/min per IP
(burst 5), 50 webhook requests/s per IP (burst 200), 50 concurrent connections per IP.
Rejections are `413` and `429` with an `X-Request-ID`.

## systemd

For a VM where Postgres and Redis are managed services or separate hosts.

```bash
# 1. Build once (CI or a build host) and copy the release to /opt/spine
pnpm install --frozen-lockfile && pnpm --filter @spine/api build
pnpm --filter @spine/api deploy --prod --legacy /tmp/spine-release
sudo mkdir -p /opt/spine && sudo cp -r apps/api/dist apps/api/migrations /tmp/spine-release/node_modules /tmp/spine-release/package.json /opt/spine/  # package.json: "type": "module"
sudo mkdir -p /opt/spine/config   # rulesets / playbooks (CONFIG_DIR)

# 2. Service account and configuration
sudo useradd --system --no-create-home --shell /usr/sbin/nologin spine
sudo install -d -m 0750 -o root -g spine /etc/spine
sudo install -m 0640 -o root -g spine .env.production /etc/spine/spine.env

# 3. Units
sudo cp infra/systemd/spine-api.service infra/systemd/spine-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now spine-api spine-worker
systemd-analyze security spine-api.service    # expect "1.3 OK"
```

The units load `/etc/spine/spine.env` (`EnvironmentFile=`), run as `spine`, and apply the
sandbox described in ADR-0083: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
`PrivateTmp`, no capabilities, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, a
`@system-service` syscall filter, `MemoryMax=768M`, `Restart=on-failure`, and
`TimeoutStopSec=30s` (longer than `SHUTDOWN_TIMEOUT_MS`, so a graceful drain is never
SIGKILLed). The worker listens for metrics on 9465 so both can share a host. Put nginx in
front exactly as in the container (copy `infra/nginx/` and render the templates, or use
the console image alone).

## Configuration reference

Every variable is validated at start-up by `apps/api/src/platform/config.ts`; invalid
configuration stops the process with a list of problems (twelve-factor III). Generated
from `config.ts` on 2026-10-28 (re-check it when you add a variable).

| Variable                              | Default                 | Notes                                                                                  |
| ------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `NODE_ENV`                            | `development`           | `development` \| `test` \| `production`. Production refuses placeholder secrets        |
| `LOG_LEVEL`                           | `info`                  | pino level (`fatal` … `trace`, `silent`)                                               |
| `SERVICE_NAME`                        | `spine-api`             | Log `service` field and `service.name` resource; worker defaults to `spine-worker`     |
| `HTTP_HOST`                           | `0.0.0.0`               | API bind address                                                                       |
| `HTTP_PORT`                           | `3000`                  | API port                                                                               |
| `TRUST_PROXY`                         | `false`                 | `true` only behind nginx (see Client IPs)                                              |
| `CORS_ALLOWED_ORIGINS`                | `http://localhost:5173` | Comma-separated origins allowed with credentials                                       |
| `RATE_LIMIT_MAX_PER_MINUTE`           | `600`                   | Per-client API limit (Redis-backed); raise for load tests                              |
| `ENABLE_API_DOCS`                     | non-production only     | Swagger UI at `/docs`                                                                  |
| `DATABASE_URL`                        | **required**            | `postgres://user:pass@host:5432/db` (Compose builds it from `POSTGRES_*`)              |
| `DATABASE_POOL_MAX`                   | `10`                    | pg pool size per process                                                               |
| `MIGRATE_ON_START`                    | `true`                  | API applies pending migrations at start (the worker never does)                        |
| `MIGRATIONS_DIR`                      | `migrations`            | `/app/migrations` in the image                                                         |
| `REDIS_URL`                           | **required**            | `redis://host:6379`                                                                    |
| `AUTH_JWT_SECRET`                     | **required**            | ≥ 32 random characters (`openssl rand -base64 48`)                                     |
| `AUTH_ACCESS_TTL_SECONDS`             | `900`                   | 60–3600                                                                                |
| `AUTH_REFRESH_TTL_SECONDS`            | `604800`                | ≥ 3600                                                                                 |
| `COOKIE_SECURE`                       | `true`                  | `false` only for plain-HTTP local use                                                  |
| `AUTH_LOGIN_MAX_PER_MINUTE`           | `10`                    | Per-IP + email login attempts per minute, in the API (nginx adds its own per-IP limit) |
| `AUTH_USER_CACHE_TTL_SECONDS`         | `30`                    | 0–30; how long a disabled user or role change may take to apply                        |
| `BOOTSTRAP_ADMIN_EMAIL`               | unset                   | First-run admin, created only when no user exists (ADR-0066)                           |
| `BOOTSTRAP_ADMIN_PASSWORD`            | unset                   | ≥ 12 characters; production refuses placeholders                                       |
| `INGEST_MAX_BACKLOG`                  | `10000`                 | Outbox backlog above which ingestion answers 503 (back-pressure)                       |
| `WEBHOOK_SOURCES_JSON`                | `{}`                    | `{"<id>": {"normalizer": "…", "secret": "≥32 chars"}}`                                 |
| `OUTBOX_POLL_INTERVAL_MS`             | `50`                    | Relay poll interval when idle                                                          |
| `OUTBOX_BATCH_SIZE`                   | `100`                   | Events per relay transaction                                                           |
| `EVENT_WORKER_CONCURRENCY`            | `8`                     | Parallel event deliveries per worker                                                   |
| `PLAYBOOK_WORKER_CONCURRENCY`         | `4`                     | Parallel playbook steps per worker                                                     |
| `PLAYBOOK_APPROVAL_SWEEP_INTERVAL_MS` | `30000`                 | How often expired approvals are swept                                                  |
| `METRICS_PORT`                        | `9464`                  | Prometheus endpoint; `0` disables it                                                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | unset                   | e.g. `http://jaeger:4318`; traces are exported only when set                           |
| `CONFIG_DIR`                          | `config`                | Rulesets and playbooks; `/app/config` in the image                                     |
| `SIMULATION_LATENCY_MS`               | `50`                    | Simulated response-action latency (ADR-0018)                                           |
| `SIMULATION_FAILURE_RATE`             | `0`                     | 0–1, injected failures for demos and chaos tests                                       |
| `SHUTDOWN_TIMEOUT_MS`                 | `15000`                 | Graceful shutdown budget; keep the orchestrator's stop timeout above it                |

Compose-only variables (read by `infra/docker-compose.yml`, not by the app):
`POSTGRES_USER`, `POSTGRES_PASSWORD` (required), `POSTGRES_DB`, `GRAFANA_ADMIN_PASSWORD`
(required), `DOCKER_REGISTRY`, `BUILD_CA_FILE`, `APK_UPGRADE`, `SPINE_BIND_ADDRESS`,
`SPINE_HSTS_MAX_AGE`, `SPINE_SERVER_NAME`, `SPINE_REAL_IP_FROM`, `SPINE_IMAGE_TAG`,
`SPINE_VERSION`, `COMPOSE_PROFILES`.

## Production checklist

- [ ] `NODE_ENV=production`, a random `AUTH_JWT_SECRET`, `COOKIE_SECURE=true`. The API **refuses to
      start** with the `.env.example` placeholders for the JWT secret, the bootstrap password or any
      webhook secret, or with `COOKIE_SECURE=false` (security review F1).
- [ ] New random webhook secrets per source (`openssl rand -hex 32`), shared only with that sensor.
- [ ] Don't run the demo seeder (`dist/cli/seed.js`): it refuses in production unless forced.
- [ ] Real `POSTGRES_PASSWORD` and `GRAFANA_ADMIN_PASSWORD`; `.env` mode `0600`.
- [ ] A CA-signed certificate in `infra/tls/`, `SPINE_HSTS_MAX_AGE=63072000`, HTTP → HTTPS redirect.
- [ ] `CORS_ALLOWED_ORIGINS` = your console origin only.
- [ ] Backups scheduled and a restore tested ([backup-restore.md](backup-restore.md)).
- [ ] Alerts routed to a human (Alertmanager) per [slos.md](slos.md).
- [ ] Images pinned by tag or digest, not `local`/`latest` ([upgrade.md](upgrade.md)).
