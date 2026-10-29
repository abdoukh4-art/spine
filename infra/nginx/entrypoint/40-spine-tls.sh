#!/bin/sh
# Runs after the image renders /etc/nginx/templates into /etc/nginx/conf.d (20-envsubst).
# TLS is enabled only when a certificate is mounted: without one, drop the TLS server so
# nginx still starts and serves plain HTTP on 8080 (local development without certs).
set -eu
if [ -r /etc/nginx/tls/server.crt ] && [ -r /etc/nginx/tls/server.key ]; then
  echo "40-spine-tls: certificate found, TLS enabled on 8443"
else
  rm -f /etc/nginx/conf.d/20-spine-tls.conf
  echo "40-spine-tls: WARNING no certificate in /etc/nginx/tls (run scripts/dev-certs.sh); TLS disabled" >&2
fi
