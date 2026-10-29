#!/usr/bin/env bash
# k6 ingest load test against the running stack (`make up` first). k6 runs in Docker, so
# nothing needs installing. Method and results: docs/operations/performance.md.
#
#   ./scripts/load-test.sh                         # login with .env's BOOTSTRAP_ADMIN_*
#   SPINE_TOKEN=<access token> ./scripts/load-test.sh
#   PEAK_RATE=300 HOLD=5m ./scripts/load-test.sh   # heavier run
#   MODE=webhook HOLD=30m PEAK_RATE=30 ./scripts/load-test.sh   # soak, signed like a sensor
#   ./scripts/load-test.sh --inspect               # validate the script only, no traffic
#
# Environment: BASE_URL (default http://localhost:8080, i.e. through nginx), PEAK_RATE,
# RAMP, HOLD, DUPLICATE_RATIO, SPINE_TOKEN or SPINE_EMAIL + SPINE_PASSWORD (default: the
# BOOTSTRAP_ADMIN_* account from .env; use the demo analyst once Phase 2 seeds it), K6_IMAGE.
#
# Before a real run, raise the API's per-client limit (RATE_LIMIT_MAX_PER_MINUTE in .env,
# then `make up`): all virtual users share one IP, and we are measuring the pipeline, not
# the abuse limiter. The `spine_rate_limited` threshold fails the run if you forget.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${K6_IMAGE:-grafana/k6:1.2.3}"
results="$root/load/results"
mkdir -p "$results"

if [[ "${1:-}" == "--inspect" ]]; then
  exec docker run --rm -v "$root/load:/load:ro" "$image" inspect /load/ingest.js
fi

# Credentials: SPINE_TOKEN wins; otherwise SPINE_EMAIL/SPINE_PASSWORD, falling back to the
# first-run admin from .env (BOOTSTRAP_ADMIN_*), who may ingest alerts (admin > analyst).
env_value() { [[ -f "$root/.env" ]] && grep -E "^$1=" "$root/.env" | tail -1 | cut -d= -f2- || true; }
email="${SPINE_EMAIL:-$(env_value BOOTSTRAP_ADMIN_EMAIL)}"
password="${SPINE_PASSWORD:-$(env_value BOOTSTRAP_ADMIN_PASSWORD)}"

# MODE=webhook (soaks): sign as a sensor with WEBHOOK_SOURCE's secret from .env (no session to expire).
mode="${MODE:-api}"
source_id="${WEBHOOK_SOURCE:-edr}"
webhook_secret="${WEBHOOK_SECRET:-}"
if [[ "$mode" == "webhook" && -z "$webhook_secret" ]]; then
  webhook_secret="$(env_value WEBHOOK_SOURCES_JSON | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");process.stdout.write(j[process.argv[1]]?.secret??"")})' \
    "$source_id")"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# --network host: the stack publishes its ports on the host's loopback interface.
# --user: k6 writes the summary into load/results, which belongs to the caller.
docker run --rm --network host --user "$(id -u):$(id -g)" \
  -v "$root/load:/load:ro" -v "$results:/results" \
  -e BASE_URL="${BASE_URL:-http://localhost:8080}" \
  -e PEAK_RATE="${PEAK_RATE:-100}" -e RAMP="${RAMP:-1m}" -e HOLD="${HOLD:-3m}" \
  -e DUPLICATE_RATIO="${DUPLICATE_RATIO:-0.1}" \
  -e SPINE_TOKEN="${SPINE_TOKEN:-}" \
  -e MODE="$mode" -e WEBHOOK_SOURCE="$source_id" -e WEBHOOK_SECRET="$webhook_secret" \
  -e SPINE_EMAIL="$email" -e SPINE_PASSWORD="$password" \
  "$image" run --summary-export "/results/ingest-$stamp.json" /load/ingest.js

echo "load-test: summary written to load/results/ingest-$stamp.json"
