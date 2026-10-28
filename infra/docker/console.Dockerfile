# syntax=docker/dockerfile:1.7
#
# Spine console image: the React SPA built by Vite, served by unprivileged nginx, which
# also reverse-proxies /api, /healthz and /readyz to the API (ADR-0082).
#
# Build from the repository root:
#   docker build -f infra/docker/console.Dockerfile -t spine-console .
# Mirrors / TLS-intercepting proxies: see the build args and secret in api.Dockerfile.

ARG NODE_IMAGE=node:22.22.0-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine

# ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    HUSKY=0 \
    NODE_EXTRA_CA_CERTS=/run/secrets/build_ca
RUN --mount=type=secret,id=build_ca,required=false \
    npm install --global --no-fund --no-audit pnpm@10.28.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=spine-pnpm,target=/pnpm/store \
    --mount=type=secret,id=build_ca,required=false \
    pnpm fetch --store-dir /pnpm/store
COPY . .
RUN --mount=type=cache,id=spine-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store \
      --filter @spine/console...
# Type-check + bundle. Output: apps/console/dist (hashed assets under /assets).
RUN pnpm --filter @spine/console build

# ---------------------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime
ARG SPINE_VERSION=0.0.0-dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="spine-console" \
      org.opencontainers.image.description="Spine SOAR console (SPA) behind nginx" \
      org.opencontainers.image.source="https://github.com/abdoukh4-art/spine" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${SPINE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

# Our server config is an envsubst template (the image renders /etc/nginx/templates/*.template
# into /etc/nginx/conf.d at start); snippets are static includes. The image's default
# server is removed so only Spine's servers listen.
USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY infra/nginx/templates/ /etc/nginx/templates/
COPY infra/nginx/snippets/ /etc/nginx/snippets/
COPY --chmod=0755 infra/nginx/entrypoint/40-spine-tls.sh /docker-entrypoint.d/40-spine-tls.sh
COPY --from=build /repo/apps/console/dist/ /usr/share/nginx/html/
USER 101

# Defaults for the template variables (override at run time; see docs/operations/deployment.md).
ENV SPINE_API_UPSTREAM=api:3000 \
    SPINE_SERVER_NAME=localhost \
    SPINE_HSTS_MAX_AGE=0 \
    SPINE_REAL_IP_FROM=127.0.0.1 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER=^(SPINE_|NGINX_LOCAL_RESOLVERS)

EXPOSE 8080 8443
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/nginx-health || exit 1
