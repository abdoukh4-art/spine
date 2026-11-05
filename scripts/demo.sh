#!/usr/bin/env bash
# One-command demo: `make demo` (which runs `make up` first).
#
#   1. waits until the stack is ready (/readyz through nginx),
#   2. seeds demo users + 7 days of synthetic alert history (idempotent),
#   3. plays the "Operation Night Owl" story through the public API
#      (scripts/demo-story.mjs): phishing, credential dumping on a critical server,
#      C2 beaconing (deduplicated), a CEF brute force and scanner noise → enrichment →
#      explainable scores → playbooks → analyst approval → simulated containment → metrics.
#
# Everything is synthetic and every response action is SIMULATED (ADR-0018).
# Options are passed through to the story, e.g. `./scripts/demo.sh --no-approve` to leave the
# containment approval pending so you can approve it yourself in the console.
set -euo pipefail

cd "$(dirname "$0")/.."
base="${BASE_URL:-http://localhost:8080}"
compose=(docker compose -f infra/docker-compose.yml --env-file .env)

echo "demo: waiting for $base/readyz ..."
for _ in $(seq 1 90); do
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

echo "demo: seeding demo users and alert history ..."
"${compose[@]}" run --rm --no-deps -T api dist/cli/seed.js >/dev/null

echo "demo: playing the story ..."
node scripts/demo-story.mjs --base-url "$base" "$@"

cat <<EOF

  Console      $base            (TLS: https://localhost:8443, self-signed)
               sign in as analyst@spine.test / ${SPINE_DEMO_ANALYST_PASSWORD:-night-owl-demo-dana-2026}
               or admin from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD in .env
  API docs     $base/docs       (non-production only)
  Grafana      http://localhost:3001  (admin / GRAFANA_ADMIN_PASSWORD from .env)
  Prometheus   http://localhost:9090
EOF
