# ADR-0082: nginx as the edge: SPA hosting, reverse proxy, TLS termination

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** infra + observability workstream
- **Tags:** ops, security

## Context and problem statement

The console (a static SPA) and the API must share one origin, so the refresh cookie and
CSRF model of ADR-0016 work without CORS. Something has to serve static files, terminate
TLS, apply coarse abuse limits before requests reach Node, and tell the API who the
client really is.

## Decision drivers

- Same-origin console + API; strict CSP for the SPA.
- TLS with modern defaults; HSTS only where it is safe.
- Correct client IPs for the API's rate limiting and audit log (`TRUST_PROXY`).
- Correlation ID on every request, including ones nginx answers itself.
- Non-root, read-only container.

## Considered options

1. **`nginxinc/nginx-unprivileged` serving the SPA and proxying `/api`, `/healthz`, `/readyz`**
2. Serve the SPA from Fastify (`@fastify/static`)
3. Caddy (automatic HTTPS)
4. Traefik

## Decision outcome

**Chosen option 1.** Configuration lives in `infra/nginx/` (templates rendered by the
image's `envsubst` step, plus static snippets). Highlights:

- **CSP for the SPA:** `default-src 'self'; script-src 'self'; style-src 'self'; img-src
'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action
'self'`, plus `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy`, `COOP`. API responses keep the API's own helmet headers.
- **Client IP:** nginx **overwrites** `X-Forwarded-For` with `$remote_addr`. Fastify with
  `TRUST_PROXY=true` trusts that header, so appending (`$proxy_add_x_forwarded_for`) would
  let a client forge its IP. If a load balancer sits in front, its address goes in
  `SPINE_REAL_IP_FROM` and `real_ip` recovers the client address first.
- **Correlation:** a well-formed inbound `X-Request-ID` is reused (same regex as the API),
  otherwise nginx's `$request_id` is used; it is forwarded, logged (JSON access log) and
  returned on every response, including nginx's own 413/429/502.
- **Limits:** `limit_req` per IP on `/api/v1/auth/login` (10/min, burst 5) and
  `/api/v1/ingest/webhooks/` (50/s, burst 200); `client_max_body_size` 1 MiB, 10 MiB on
  `/api/v1/ingest/batch`; `limit_conn` 50 per IP; upstream timeouts 5 s connect / 30 s read.
- **Compression:** static assets only. API responses are not gzipped (BREACH: secrets
  and attacker-influenced input in one compressed TLS response).
- **TLS:** Mozilla "intermediate" (TLS 1.2 + 1.3), no session tickets, HTTP/2. The TLS
  server is enabled only when a certificate is mounted (`scripts/dev-certs.sh` makes a
  self-signed one). HSTS is sent only over TLS and its `max-age` comes from
  `SPINE_HSTS_MAX_AGE` (0 for `localhost`, because HSTS ignores ports and would force
  HTTPS onto every other local dev server). OCSP stapling is documented but off.
- **Upstream re-resolution:** `server api:3000 resolve` (nginx ≥ 1.27.3) with Docker's
  resolver. Without it, recreating the API container (new IP) produced 502s until nginx
  restarted; we hit exactly that while testing.
- **SPA:** hashed `/assets/*` cached for a year, `index.html` `no-cache`, client-side
  routes fall back to `index.html`, dotfiles denied.

### Consequences

- 👍 One origin, strict CSP, no CORS in production.
- 👍 Abuse limits and body-size limits are enforced before any Node code runs.
- 👎 Two places define security headers (nginx for the SPA, helmet for the API). Each
  file says which it owns.
- 👎 Certificates are managed outside nginx (no ACME client in the image). Production
  mounts certificates from the host or a secret store.
- ⚖️ Port 8080 serves the full app over plain HTTP for local use; the template documents
  the one-line redirect for production.

## Pros and cons of the options

### Fastify static

- 👍 One fewer container.
- 👎 Node then does TLS, static files and abuse limiting, which is the work nginx is built for.

### Caddy

- 👍 Automatic HTTPS, simpler config.
- 👎 Less common in the job market this project teaches for; ACME needs a public name,
  which a laptop demo doesn't have.

### Traefik

- 👍 Docker-aware routing.
- 👎 Needs the Docker socket (a root-equivalent privilege) for discovery; overkill for one upstream.

## What would make us revisit this

- Multiple API replicas behind one nginx → `upstream` with several servers and health checks.
- A managed load balancer terminates TLS → nginx keeps only SPA hosting and headers.

## Further reading

- Mozilla, _Server Side TLS_ guidelines and SSL Configuration Generator
- OWASP, _HTTP Security Response Headers Cheat Sheet_; _Content Security Policy Cheat Sheet_
- nginx docs, `ngx_http_realip_module`, `ngx_http_limit_req_module`, `upstream … resolve`
