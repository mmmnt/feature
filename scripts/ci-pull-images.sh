#!/usr/bin/env bash
# Pulls the container images the adapter suites start, with retries, before the suites run.
# A registry hiccup (a DNS timeout reaching Docker Hub) used to fail a suite mid-run and, on main,
# the release that waits for CI. Pulling up front turns that into a retried step: three tries per
# image, 15 s apart. The list mirrors each adapter's fixture IMAGE constant; a test that pulls an
# image missing here still works, it just isn't pre-pulled.
set -uo pipefail
IMAGES=(
  "amazon/dynamodb-local:2.6.1"
  "amazon/dynamodb-local"
  "apache/kafka:3.9.0"
  "ghcr.io/shopify/toxiproxy:2.12.0"
  "kurrentplatform/kurrentdb:26.2.3"
  "neo4j:2026.01.4-community"
  "node:22.12.0-slim"
  "nsmithuk/local-kms@sha256:e070866476b20973a9e23a9b636204b7a222e4169a6e03198d27b80d47ed28e3"
  "redis@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90"
)
failed=0
for image in "${IMAGES[@]}"; do
  ok=0
  for attempt in 1 2 3; do
    if docker pull --quiet "$image" > /dev/null; then ok=1; break; fi
    echo "ci-pull-images: $image: attempt $attempt failed" >&2
    [ "$attempt" -lt 3 ] && sleep 15
  done
  if [ "$ok" = 1 ]; then echo "ci-pull-images: $image"; else echo "::error::could not pull $image" >&2; failed=1; fi
done
exit "$failed"
