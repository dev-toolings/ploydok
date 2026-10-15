#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
shuttle_bin="${SHUTTLE_BIN:-$HOME/.local/lib/ploydok-shuttle/shuttle}"
[[ -x "$shuttle_bin" ]] || { echo "Shuttle with deploy existing-stack support is required: $shuttle_bin" >&2; exit 2; }
if [[ " ${*:-} " == *" --dry-run "* ]]; then
  exec "$shuttle_bin" deploy existing-stack --config deploy/shuttle-staging.json "$@"
fi
export PLOYDOK_SHUTTLE_SCAN_CACHE="$(mktemp -d /tmp/ploydok-shuttle-scan.XXXXXX)"
export PLOYDOK_SHUTTLE_SCAN_REPORTS="$HOME/.local/state/ploydok/shuttle-scans/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$PLOYDOK_SHUTTLE_SCAN_REPORTS"
scanner_new=0
docker image inspect aquasec/trivy:0.67.2 >/dev/null 2>&1 || scanner_new=1
cleanup() {
  status=$?
  trap - EXIT
  rm -rf -- "$PLOYDOK_SHUTTLE_SCAN_CACHE"
  if ((scanner_new)); then docker image rm aquasec/trivy:0.67.2 >/dev/null 2>&1 || true; fi
  printf '[ploydok] Scan evidence: %s\n' "$PLOYDOK_SHUTTLE_SCAN_REPORTS"
  df -B1 "$root"
  exit "$status"
}
trap cleanup EXIT
df -B1 "$root"
"$shuttle_bin" deploy existing-stack --config deploy/shuttle-staging.json "$@"
