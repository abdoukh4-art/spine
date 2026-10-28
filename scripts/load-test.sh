#!/usr/bin/env bash
# k6 ingest load test against the running stack (`make up` first). k6 runs in Docker, so
# nothing needs installing. Method and results: docs/operations/performance.md.
#
#   ./scripts/load-test.sh                         # login as the demo analyst
#   SPINE_TOKEN=<access token> ./scripts/load-test.sh
#   PEAK_RATE=300 HOLD=5m ./scripts/load-test.sh   # heavier run
#   ./scripts/load-test.sh --inspect               # validate the script only, no traffic
#
# Environment: BASE_URL (default http://localhost:8080, i.e. through nginx), PEAK_RATE,
# RAMP, HOLD, DUPLICATE_RATIO, SPINE_TOKEN or SPINE_EMAIL + SPINE_PASSWORD, K6_IMAGE.
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

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# --network host: the stack publishes its ports on the host's loopback interface.
docker run --rm --network host \
  -v "$root/load:/load:ro" -v "$results:/results" \
  -e BASE_URL="${BASE_URL:-http://localhost:8080}" \
  -e PEAK_RATE="${PEAK_RATE:-100}" -e RAMP="${RAMP:-1m}" -e HOLD="${HOLD:-3m}" \
  -e DUPLICATE_RATIO="${DUPLICATE_RATIO:-0.1}" \
  -e SPINE_TOKEN="${SPINE_TOKEN:-}" \
  -e SPINE_EMAIL="${SPINE_EMAIL:-analyst@spine.local}" \
  -e SPINE_PASSWORD="${SPINE_PASSWORD:-}" \
  "$image" run --summary-export "/results/ingest-$stamp.json" /load/ingest.js

echo "load-test: summary written to load/results/ingest-$stamp.json"
