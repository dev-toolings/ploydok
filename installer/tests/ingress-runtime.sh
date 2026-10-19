#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Exercise the real quiesce/resume functions with a zero-replica descriptor.
# No daemon, database, privileged filesystem or installer main is invoked.
source <(sed -n '/^quiesce() {$/,/^}$/p; /^resume() {$/,/^}$/p' "$ROOT/installer/ploydok-dr")
runtime_kind() { echo swarm; }
descriptor_path() { echo "$TMP/stack.yml"; }
real_path() { echo "$1"; }
fail() { echo "$*" >&2; exit 1; }
docker() {
  printf '%s\n' "$*" >>"$TMP/docker.log"
  case "$1 $2" in
    'service inspect') echo 0 ;;
    'service scale') ;;
    'ps -q')
      if [[ "$*" == *'name=^/ploydok-caddy$'* ]]; then echo ingress-id; fi ;;
    'pause ingress-id'|'unpause ingress-id') ;;
    *) echo "unexpected docker call: $*" >&2; exit 1 ;;
  esac
}
DRY_RUN=0 QUIESCED=0 RECREATE_ON_RESUME=0 DATA_DIR="$TMP"
SWARM_SERVICE_REPLICAS=() PAUSED_CONTAINERS=() COMPOSE_RUNNING_SERVICES=()
quiesce
[[ "${PAUSED_CONTAINERS[*]}" == ingress-id ]]
grep -Fxq 'pause ingress-id' "$TMP/docker.log"
resume
grep -Fxq 'unpause ingress-id' "$TMP/docker.log"
echo 'standalone ingress DR quiesce/resume tests OK'

# Upgrade must wait for real readiness, including standalone runtime revision.
source <(sed -n '/^swarm_healthcheck() {$/,/^}$/p' "$ROOT/installer/ploydok-cli")
swarm_monitoring_healthcheck() { return 0; }
sleep() { :; }
docker() {
  case "$1 $2" in
    'service inspect') echo 1 ;;
    'ps -q') echo api-id ;;
    'inspect --format') echo healthy ;;
    'exec api-id')
      [[ "$*" == *'/health/ready'* ]] || exit 1
      count="$(cat "$TMP/probes" 2>/dev/null || echo 0)"
      count=$((count + 1)); echo "$count" >"$TMP/probes"
      [[ "$count" -ge 2 ]] ;;
    *) echo "unexpected readiness Docker call: $*" >&2; exit 1 ;;
  esac
}
swarm_healthcheck
[[ "$(cat "$TMP/probes")" == 2 ]]
echo 'Swarm upgrade ingress readiness gate tests OK'
