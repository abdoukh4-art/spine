# syntax=docker/dockerfile:1.7
#
# Spine API + worker image (ADR-0081). ONE image, two processes:
#   api:    docker run spine-api                      (CMD dist/main.js)
#   worker: docker run spine-api dist/worker.js       (override CMD)
#
# Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t spine-api .
# Docker Hub rate-limits some environments; use a mirror for the build image:
#   docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22.22.0-bookworm-slim ...
#
# Stages: deps (lockfile-only fetch, cached) → build (esbuild bundle, ADR-0027) →
#         prod (pnpm deploy: production node_modules only) → runtime (distroless, non-root).

ARG NODE_IMAGE=node:22.22.0-bookworm-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot

# ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    HUSKY=0
# Behind a TLS-intercepting proxy, pass its CA as a BuildKit secret (never baked into a layer):
#   docker build --secret id=build_ca,src=/path/to/ca-bundle.crt ...
# Without the secret the file does not exist and Node just ignores the variable.
ENV NODE_EXTRA_CA_CERTS=/run/secrets/build_ca
# Exact pnpm version from package.json#packageManager (no corepack download at runtime).
RUN --mount=type=secret,id=build_ca,required=false \
    npm install --global --no-fund --no-audit pnpm@10.28.0
WORKDIR /repo
# Only the lockfile + workspace manifest: this layer (and its download cache) is reused
# until a dependency changes, however often the source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=spine-pnpm,target=/pnpm/store \
    --mount=type=secret,id=build_ca,required=false \
    pnpm fetch --store-dir /pnpm/store

# ---------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=spine-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store \
      --filter @spine/api...
RUN cd apps/api && node build.mjs
# Production dependencies only, as a self-contained folder (no workspace symlinks).
# --legacy: pnpm 10's deploy otherwise requires inject-workspace-packages=true. Legacy
# deploy re-reads registry metadata (not tarballs: those come from the store), so it is
# not --offline; versions still come from the frozen lockfile.
RUN --mount=type=cache,id=spine-pnpm,target=/pnpm/store \
    --mount=type=secret,id=build_ca,required=false \
    pnpm --filter @spine/api deploy --prod --legacy --frozen-lockfile --store-dir /pnpm/store /out \
 && mkdir -p apps/api/config

# ---------------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
ARG SPINE_VERSION=0.0.0-dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="spine-api" \
      org.opencontainers.image.description="Spine SOAR API and worker" \
      org.opencontainers.image.source="https://github.com/abdoukh4-art/spine" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${SPINE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

WORKDIR /app
# Files stay owned by root and are read-only for the runtime user (uid 65532): a
# compromised process cannot rewrite its own code. Nothing here needs to be writable.
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/migrations ./migrations
COPY --from=build /repo/apps/api/config ./config
COPY infra/docker/healthcheck.mjs ./healthcheck.mjs

ENV NODE_ENV=production \
    SPINE_VERSION=${SPINE_VERSION} \
    MIGRATIONS_DIR=/app/migrations \
    CONFIG_DIR=/app/config \
    HTTP_PORT=3000 \
    METRICS_PORT=9464

USER nonroot
EXPOSE 3000 9464

# No shell in distroless: health is probed over HTTP by the orchestrator, or by
# `node /app/healthcheck.mjs <url>` (see infra/docker-compose.yml).
# --import loads the telemetry preload before the app (ADR-0080).
ENTRYPOINT ["/nodejs/bin/node", "--enable-source-maps", "--import", "./dist/instrument.js"]
CMD ["dist/main.js"]
