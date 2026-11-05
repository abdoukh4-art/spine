# ADR-0081: Container images: one distroless non-root image for API and worker

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** infra + observability workstream
- **Tags:** ops, security

## Context and problem statement

Spine ships two Node processes (API, worker) from one codebase, plus a static SPA. The
images must be small, reproducible, safe to run (non-root, nothing writable, little to
exploit) and buildable both in CI and on a laptop behind Docker Hub rate limits or a
TLS-intercepting proxy.

## Decision drivers

- Least privilege and minimal attack surface (OWASP A05 Security Misconfiguration).
- Reproducible builds from the frozen lockfile (ADR-0022).
- Twelve-factor V (build, release, run separated) and X (dev/prod parity).
- Fast rebuilds: dependency layers cached independently of source changes.

## Considered options

1. **Multi-stage build → `gcr.io/distroless/nodejs22-debian13:nonroot`, one image, the
   process chosen by `CMD`**
2. `node:22-*-slim` runtime with `USER node`
3. Two separate images (api, worker)
4. Alpine (`node:22-alpine`)

## Decision outcome

**Chosen option 1.** `infra/docker/api.Dockerfile`:

1. `deps`: install the exact pnpm version, copy **only** the lockfile, `pnpm fetch` into
   a BuildKit cache. This layer survives every source-only change.
2. `build`: copy the source, `pnpm install --offline --frozen-lockfile`, bundle with
   esbuild (ADR-0027), then `pnpm deploy --prod --legacy` to get a self-contained
   production `node_modules`.
3. `runtime`: distroless, uid 65532, files owned by root and read-only for the process.
   It contains `dist/`, `node_modules/`, `migrations/`, `config/` and a 10-line
   `healthcheck.mjs`. `ENTRYPOINT` loads the telemetry preload (ADR-0080); `CMD` is
   `dist/main.js`, and the worker runs the same image with `dist/worker.js`.

Supporting choices:

- **Debian 13 base.** Trivy found 7 fixable HIGH/CRITICAL OpenSSL findings in the Debian 12
  distroless image and none in the Debian 13 one (see the PR), so build and runtime use
  `trixie`/`debian13` with the same Node major.
- **Base images are build ARGs** (`NODE_IMAGE`, `RUNTIME_IMAGE`, `NGINX_IMAGE`). Compose
  prefixes them with `DOCKER_REGISTRY`, so a laptop can use `mirror.gcr.io` while CI uses
  Docker Hub.
- **Behind a TLS-intercepting proxy**, the proxy CA is passed as a BuildKit secret
  (`--secret id=build_ca`), so it never lands in a layer. Without the secret the build
  behaves exactly as before.
- **Healthcheck:** distroless has no shell, `curl` or `wget`. Orchestrators use HTTP
  probes (`/healthz`, `/readyz`); Docker Compose runs `node /app/healthcheck.mjs <url>`.
  The worker's probe is its metrics endpoint (same event loop, so it is a real liveness signal).

### Consequences

- 👍 No shell, no package manager, no `npm` in the runtime: a remote code execution has
  very little to work with, and image scans have little to report.
- 👍 Process cannot modify its own code (root-owned files, `read_only: true` in compose).
- 👍 One image to build, scan and promote; API/worker version skew is impossible.
- 👎 Debugging inside the container is harder (no shell). Use `docker run --entrypoint
/nodejs/bin/node … -e '…'` or the `:debug-nonroot` distroless variant locally.
- 👎 Distroless pins the Node patch version chosen by Google's image, which can differ
  from the build image's (we keep them on the same major and rebuild weekly).
- ⚖️ `pnpm deploy --legacy` re-reads registry metadata, so that step is not `--offline`.

## Pros and cons of the options

### `node:22-slim` + `USER node`

- 👍 Has a shell for debugging; official image.
- 👎 Ships npm, corepack, a shell and ~90 Debian packages: more CVEs and more tools for an attacker.

### Two images

- 👍 Each image could drop what it doesn't need.
- 👎 The code is the same bundle tree; two images double build/scan time and allow version skew.

### Alpine

- 👍 Small.
- 👎 musl: the prebuilt `@node-rs/argon2` binary and some Node behaviours differ from
  the glibc builds we test on; Node's official support for musl is "experimental".

## What would make us revisit this

- A native dependency that needs a system library distroless lacks.
- Node 24 becomes the project's runtime (ADR-0003) → `nodejs24-debian13`.

## Further reading

- Google, _distroless_ README; Docker docs, _Multi-stage builds_, _Build secrets_
- pnpm docs, _pnpm fetch_ and _pnpm deploy_
- NIST SP 800-190, _Application Container Security Guide_
