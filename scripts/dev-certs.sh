#!/usr/bin/env bash
# Creates a self-signed TLS certificate for local use in infra/tls/ (git-ignored).
# nginx (console container) serves it on https://localhost:8443.
#
#   ./scripts/dev-certs.sh            # creates the pair if missing
#   ./scripts/dev-certs.sh --force    # recreates it
#
# DEVELOPMENT ONLY. Browsers will warn because no trusted CA signed it. For a cert your
# browser trusts locally, use mkcert (https://github.com/FiloSottile/mkcert) and write
# the files to the same paths. In production, use certificates from your CA / ACME client.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$root/infra/tls"
crt="$dir/server.crt"
key="$dir/server.key"

if [[ -f "$crt" && -f "$key" && "${1:-}" != "--force" ]]; then
  echo "dev-certs: $crt already exists (use --force to recreate)"
  exit 0
fi

mkdir -p "$dir"
san="subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"

if command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -days 397 -subj "/CN=localhost" -addext "$san" \
    -keyout "$key" -out "$crt" 2>/dev/null
else
  # No local openssl: run it in a throwaway container instead.
  docker run --rm -v "$dir:/out" "${ALPINE_IMAGE:-mirror.gcr.io/library/alpine:3.22}" sh -c \
    "apk add --no-cache openssl >/dev/null && openssl req -x509 -newkey ec \
     -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 397 -subj /CN=localhost \
     -addext '$san' -keyout /out/server.key -out /out/server.crt 2>/dev/null"
fi

# nginx runs as uid 101 inside the container and must read the key through the bind
# mount. A world-readable key is acceptable ONLY for a throwaway self-signed dev cert.
chmod 0644 "$key" "$crt"
echo "dev-certs: wrote $crt and $key (valid 397 days, CN=localhost)"
