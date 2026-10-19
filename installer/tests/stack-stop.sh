#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
export STOP_LOG="$TMP/docker.log" STOP_STATE="$TMP/state"
export PLOYDOK_STACK_REMOVE_MARKER="$TMP/removal.pending"
cat >"$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$STOP_LOG"
case "$1 $2" in
  'stack rm') ;;
  'service ls')
    count="$(cat "$STOP_STATE" 2>/dev/null || echo 0)"
    count=$((count + 1)); printf '%s' "$count" >"$STOP_STATE"
    if [[ "${STOP_STUCK:-0}" == 1 || "$count" -lt 2 ]]; then echo ploydok_api; fi ;;
  'ps -q') ;;
  'inspect --format') echo caddy ;;
  'rm -f') [[ "$3" == ploydok-caddy ]] ;;
  'network ls')
    if [[ "${STOP_STUCK:-0}" == 1 || "$(cat "$STOP_STATE")" -lt 3 ]]; then echo ploydok_ploydok; fi ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 2 ;;
esac
SH
chmod +x "$TMP/bin/docker"
PATH="$TMP/bin:$PATH" bash "$ROOT/installer/templates/ploydok-stop-stack.sh"
[[ "$(cat "$STOP_STATE")" == 3 ]]
[[ ! -e "$PLOYDOK_STACK_REMOVE_MARKER" ]]
grep -Fq 'label=com.docker.stack.namespace=ploydok' "$STOP_LOG"
grep -Fq 'rm -f ploydok-caddy' "$STOP_LOG"
! grep -Eq 'volume|prune' "$STOP_LOG"
if PATH="$TMP/bin:$PATH" STOP_STUCK=1 PLOYDOK_STACK_REMOVE_TIMEOUT_SECONDS=1 \
  bash "$ROOT/installer/templates/ploydok-stop-stack.sh" >"$TMP/error" 2>&1; then
  echo 'stuck stack removal was accepted' >&2; exit 1
fi
grep -Fq 'timed out after 1s' "$TMP/error"
grep -Fq 'ploydok_api' "$TMP/error"
grep -Fq 'ploydok_ploydok' "$TMP/error"
[[ -f "$PLOYDOK_STACK_REMOVE_MARKER" ]]
if PATH="$TMP/bin:$PATH" STOP_STUCK=1 PLOYDOK_STACK_REMOVE_TIMEOUT_SECONDS=1 \
  bash "$ROOT/installer/templates/ploydok-stop-stack.sh" wait >"$TMP/error" 2>&1; then
  echo 'deploy wait accepted an incomplete removal' >&2; exit 1
fi
PATH="$TMP/bin:$PATH" bash "$ROOT/installer/templates/ploydok-stop-stack.sh" wait
[[ ! -e "$PLOYDOK_STACK_REMOVE_MARKER" ]]
PATH="$TMP/bin:$PATH" bash "$ROOT/installer/templates/ploydok-stop-stack.sh" wait
echo 'stack stop ordering, timeout and redeploy wait tests OK'
