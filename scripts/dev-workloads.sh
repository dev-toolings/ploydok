#!/bin/sh
# Local dev must not outlive a stopped stack.
#
# Compose services use restart "no". `docker buildx create` hardcodes
# unless-stopped, and a Swarm service with replicas=1 is recreated on
# dockerd start even when Caddy and the API are down. `quiesce` records
# the desired replica count and scales those services to 0. `restore`
# runs from `make dev`, before the API boots, so the boot reconciler
# sees the app already live and does not start a second runtime.
# `buildx-pin` forces the dev builder to restart "no" after bootstrap.

set -eu

snapshot="${HOME}/.ploydok-dev/swarm-scale.list"
builder="${BUILDX_BUILDER:-ploydok-dev}"

is_workload() {
  case "$1" in
    ploydok-app-* | ploydok-db-*) return 0 ;;
    *) return 1 ;;
  esac
}

is_replicas() {
  case "$1" in
    "" | 0 | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

pin_buildx() {
  docker update --restart=no "buildx_buildkit_${builder}0" >/dev/null 2>&1 || true
}

quiesce() {
  mkdir -p "${HOME}/.ploydok-dev"
  if [ -s "$snapshot" ]; then
    while read -r name replicas; do
      [ -n "$name" ] || continue
      docker service scale --detach "${name}=0" >/dev/null 2>&1 || true
    done < "$snapshot"
    return 0
  fi

  tmp=$(mktemp)
  docker service ls --format '{{.Name}}' 2>/dev/null | while read -r name; do
    is_workload "$name" || continue
    replicas=$(
      docker service inspect -f '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}0{{end}}' "$name" 2>/dev/null || echo 0
    )
    is_replicas "$replicas" || continue
    printf '%s %s\n' "$name" "$replicas"
    docker service scale --detach "${name}=0" >/dev/null 2>&1 || true
  done > "$tmp"

  if [ -s "$tmp" ]; then
    mv "$tmp" "$snapshot"
  else
    rm -f "$tmp"
  fi
}

wait_running() {
  name=$1
  i=0
  while [ "$i" -lt 20 ]; do
    state=$(
      docker service ps --filter desired-state=running --format '{{.CurrentState}}' "$name" 2>/dev/null | head -n 1
    )
    case "$state" in
      Running*) return 0 ;;
    esac
    i=$((i + 1))
    sleep 1
  done
}

restore() {
  [ -s "$snapshot" ] || return 0
  while read -r name replicas; do
    [ -n "$name" ] || continue
    is_workload "$name" || continue
    is_replicas "$replicas" || continue
    docker service inspect "$name" >/dev/null 2>&1 || continue
    docker service scale --detach "${name}=${replicas}" >/dev/null 2>&1 || continue
    wait_running "$name"
  done < "$snapshot"
  rm -f "$snapshot"
}

case "${1:-}" in
  quiesce) quiesce ;;
  restore) restore ;;
  buildx-pin) pin_buildx ;;
  *)
    echo "usage: dev-workloads.sh quiesce|restore|buildx-pin" >&2
    exit 2
    ;;
esac
