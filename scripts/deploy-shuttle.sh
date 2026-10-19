#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
shuttle_bin="${SHUTTLE_BIN:-$(command -v shuttle || true)}"
[[ -n "$shuttle_bin" && -x "$shuttle_bin" ]] || { echo "shuttle is required on PATH (make install in deploy-shuttle)" >&2; exit 2; }
"$shuttle_bin" deploy existing-stack --help >/dev/null 2>&1 || { echo "$shuttle_bin lacks deploy existing-stack" >&2; exit 2; }
if [[ " ${*:-} " == *" --dry-run "* ]]; then
  exec "$shuttle_bin" deploy existing-stack --config deploy/shuttle-staging.json "$@"
fi
# Persistent so the vulnerability DB (refreshed by Trivy once it is stale) and
# the analysis of unchanged layers are not downloaded and redone every deploy.
export PLOYDOK_SHUTTLE_SCAN_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/ploydok/trivy"
scan_cache_max_bytes=$((4 * 1024 * 1024 * 1024))
mkdir -p "$PLOYDOK_SHUTTLE_SCAN_CACHE"
export PLOYDOK_SHUTTLE_SCAN_REPORTS="$HOME/.local/state/ploydok/shuttle-scans/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$PLOYDOK_SHUTTLE_SCAN_REPORTS"
cleanup() {
  status=$?
  trap - EXIT
  # Bound the layer analysis cache; the DB itself stays.
  if (($(du -sb "$PLOYDOK_SHUTTLE_SCAN_CACHE" | cut -f1) > scan_cache_max_bytes)); then
    rm -rf -- "$PLOYDOK_SHUTTLE_SCAN_CACHE/fanal"
  fi
  # shuttle creates its builder with unless-stopped: a dockerd restart would
  # bring it back outside any deploy.
  sh "$root/scripts/dev-workloads.sh" buildx-pin
  printf '[ploydok] Scan evidence: %s\n' "$PLOYDOK_SHUTTLE_SCAN_REPORTS"
  df -B1 "$root"
  exit "$status"
}
trap cleanup EXIT
df -B1 "$root"
"$shuttle_bin" deploy existing-stack --config deploy/shuttle-staging.json "$@"
bun "$root/scripts/deploy-shuttle/smoke.ts"
