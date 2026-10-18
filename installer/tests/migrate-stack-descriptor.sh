#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MIGRATE="$ROOT/installer/migrate-stack-descriptor"

fail() { echo "migrate-stack-descriptor: $*" >&2; exit 1; }

# A descriptor rendered before Swarm tmpfs mounts were used: api already has a
# volumes list, web has none.
cat >"$TMP/legacy.yml" <<'YAML'
version: "3.8"

services:
  api:
    image: registry/ploydok-api@sha256:abc
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=256m
    volumes:
      - /var/lib/ploydok/logs:/var/log/ploydok
    networks:
      - ploydok

  web:
    image: registry/ploydok-web@sha256:def
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    environment:
      PLOYDOK_API_URL: http://api:3335

networks:
  ploydok:
YAML
chmod 0640 "$TMP/legacy.yml"

[[ "$(bash "$MIGRATE" "$TMP/legacy.yml")" == "migrated" ]] || fail "legacy descriptor not reported as migrated"
! grep -qE '^    tmpfs:' "$TMP/legacy.yml" || fail "service-level tmpfs key left behind"
[[ "$(grep -c -- '- type: tmpfs' "$TMP/legacy.yml")" == 2 ]] || fail "expected one tmpfs mount per service"
[[ "$(grep -c '^    volumes:' "$TMP/legacy.yml")" == 2 ]] || fail "each service must have exactly one volumes key"
grep -Fq "size: 268435456" "$TMP/legacy.yml" || fail "api tmpfs size not converted to bytes"
grep -Fq "size: 67108864" "$TMP/legacy.yml" || fail "web tmpfs size not converted to bytes"
grep -Fq -- "- /var/lib/ploydok/logs:/var/log/ploydok" "$TMP/legacy.yml" || fail "existing api volume dropped"
[[ "$(stat -c %a "$TMP/legacy.yml")" == 640 ]] || fail "descriptor mode not preserved"

cp "$TMP/legacy.yml" "$TMP/once.yml"
[[ -z "$(bash "$MIGRATE" "$TMP/legacy.yml")" ]] || fail "second run must be a no-op"
cmp -s "$TMP/legacy.yml" "$TMP/once.yml" || fail "second run changed the descriptor"

cp "$ROOT/installer/templates/docker-stack.yml" "$TMP/current.yml"
[[ -z "$(bash "$MIGRATE" "$TMP/current.yml")" ]] || fail "current template must not need migration"
cmp -s "$ROOT/installer/templates/docker-stack.yml" "$TMP/current.yml" || fail "current template was rewritten"

echo "migrate-stack-descriptor tests OK"
