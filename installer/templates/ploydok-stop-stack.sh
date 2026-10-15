#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

# Swarm removal is asynchronous. Keep systemd stop/start and uninstall ordered.
# Remove stack objects only; named volumes and application data are preserved.
action="${1:-remove}"
marker="${PLOYDOK_STACK_REMOVE_MARKER:-/run/ploydok-stack-removal.pending}"
case "$action" in
  wait) [[ -f "$marker" ]] || exit 0 ;;
  remove) ;;
  *) echo 'usage: stop-stack.sh [remove|wait]' >&2; exit 2 ;;
esac
wait_seconds="${PLOYDOK_STACK_REMOVE_TIMEOUT_SECONDS:-120}"
[[ "$wait_seconds" =~ ^[1-9][0-9]*$ ]] || {
  echo '[ploydok-stop] invalid PLOYDOK_STACK_REMOVE_TIMEOUT_SECONDS' >&2
  exit 2
}
deadline=$((SECONDS + wait_seconds))
if [[ "$action" == remove ]]; then
  # A failed or timed-out stop must prevent the next deploy from racing it.
  touch "$marker"
  docker stack rm ploydok
fi
while :; do
  services="$(docker service ls --filter label=com.docker.stack.namespace=ploydok --format '{{.Name}}')" || {
    echo '[ploydok-stop] could not inspect remaining stack services' >&2
    exit 1
  }
  networks="$(docker network ls --filter label=com.docker.stack.namespace=ploydok --format '{{.Name}}')" || {
    echo '[ploydok-stop] could not inspect remaining stack networks' >&2
    exit 1
  }
  if [[ -z "$services" && -z "$networks" ]]; then
    rm -f -- "$marker"
    exit 0
  fi
  if ((SECONDS >= deadline)); then
    printf '[ploydok-stop] timed out after %ss removing stack; services: %s; networks: %s\n' \
      "$wait_seconds" "${services:-none}" "${networks:-none}" >&2
    exit 1
  fi
  sleep 1
done
