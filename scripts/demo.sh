#!/usr/bin/env bash
# One-command demo (`make demo` runs `make up` first). PLACEHOLDER until Phase 2: the demo
# workstream adds the seeded analyst, the synthetic incident story and its narration.
# Today it waits for the stack to be ready and prints where everything is.
set -euo pipefail

base="${BASE_URL:-http://localhost:8080}"

echo "demo: waiting for $base/readyz ..."
for _ in $(seq 1 60); do
  if curl -fsS "$base/readyz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [[ -z "${ready:-}" ]]; then
  echo "demo: the stack did not become ready; see 'make logs'" >&2
  exit 1
fi

cat <<EOF
demo: stack is ready.

  Console      $base            (TLS: https://localhost:8443, self-signed)
  API docs     $base/docs       (non-production only)
  Grafana      http://localhost:3001  (admin / GRAFANA_ADMIN_PASSWORD from .env)
  Prometheus   http://localhost:9090

The scripted incident story arrives in Phase 2 (demo workstream).
EOF
