#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail
image="${1:?image is required}"
cache="${PLOYDOK_SHUTTLE_SCAN_CACHE:?run scripts/deploy-shuttle.sh}"
reports="${PLOYDOK_SHUTTLE_SCAN_REPORTS:?run scripts/deploy-shuttle.sh}"
case "$image" in 127.0.0.1:5000/ploydok-*) ;; *) echo 'unexpected staging image' >&2; exit 2 ;; esac
report="${image##*/}"
report="${report//:/-}.json"
docker run --rm --user "$(id -u):$(id -g)" \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v "$cache:/cache" -v "$reports:/reports" \
  -e TRIVY_CACHE_DIR=/cache -e HOME=/cache \
  aquasec/trivy:0.67.2 image --image-src docker --scanners vuln \
  --db-repository public.ecr.aws/aquasecurity/trivy-db:2 \
  --exit-code 1 --ignore-unfixed --severity CRITICAL \
  --format json --output "/reports/$report" "$image"
printf '[ploydok] Critical vulnerability scan passed: %s\n' "$image"
