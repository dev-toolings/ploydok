#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/install" "$TMP/data"
touch "$TMP/install/docker-compose.yml" "$TMP/data/.env"

digest="sha256:$(printf 'b%.0s' {1..64})"
manifest="$TMP/release-images.env"
cat >"$manifest" <<EOF
PLOYDOK_API_IMAGE=ghcr.io/dev-toolings/ploydok-api@$digest
PLOYDOK_WEB_IMAGE=ghcr.io/dev-toolings/ploydok-web@$digest
PLOYDOK_AGENT_IMAGE=ghcr.io/dev-toolings/ploydok-agent@$digest
PLOYDOK_ADMINER_IMAGE=ghcr.io/dev-toolings/ploydok-adminer@$digest
PLOYDOK_CADDY_IMAGE=ghcr.io/dev-toolings/ploydok-caddy@$digest
EOF

cat >"$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == "compose" ]]; then
  service="${@: -1}"
  printf 'container-%s\n' "$service"
elif [[ "$1" == "inspect" ]]; then
  service="${@: -1}"
  if [[ "$3" == '{{.State.Running}}' ]]; then
    printf '%s\n' "${FAKE_RELEASE_RUNNING:-true}"
    exit 0
  fi
  service="${service#container-}"
  service="${service#ploydok-}"
  key="PLOYDOK_${service^^}_IMAGE"
  value="$(awk -F= -v key="$key" '$1 == key { print $2 }' "$FAKE_RELEASE_MANIFEST")"
  [[ "${FAKE_RELEASE_MISMATCH:-}" != "$service" ]] || value="${value%sha256:*}sha256:$(printf 'c%.0s' {1..64})"
  printf '%s\n' "$value"
elif [[ "$1" == "service" && "$2" == "inspect" ]]; then
  service="${@: -1}"
  service="${service#ploydok_}"
  key="PLOYDOK_${service^^}_IMAGE"
  awk -F= -v key="$key" '$1 == key { print $2 }' "$FAKE_RELEASE_MANIFEST"
else
  echo "unexpected docker invocation: $*" >&2
  exit 2
fi
EOF
chmod +x "$TMP/bin/docker"

PATH="$TMP/bin:$PATH" FAKE_RELEASE_MANIFEST="$manifest" \
  bash "$ROOT/installer/verify-release-images" "$manifest" "$TMP/install" "$TMP/data" >/dev/null

if PATH="$TMP/bin:$PATH" FAKE_RELEASE_MANIFEST="$manifest" FAKE_RELEASE_MISMATCH=caddy \
  bash "$ROOT/installer/verify-release-images" "$manifest" "$TMP/install" "$TMP/data" >/dev/null 2>&1; then
  echo "release verifier accepted a mismatched active digest" >&2
  exit 1
fi

rm "$TMP/install/docker-compose.yml"
touch "$TMP/install/docker-stack.yml"
PATH="$TMP/bin:$PATH" FAKE_RELEASE_MANIFEST="$manifest" \
  bash "$ROOT/installer/verify-release-images" "$manifest" "$TMP/install" "$TMP/data" >/dev/null

if PATH="$TMP/bin:$PATH" FAKE_RELEASE_MANIFEST="$manifest" FAKE_RELEASE_MISMATCH=caddy \
  bash "$ROOT/installer/verify-release-images" "$manifest" "$TMP/install" "$TMP/data" >/dev/null 2>&1; then
  echo "release verifier accepted a stale standalone Caddy image" >&2; exit 1
fi
if PATH="$TMP/bin:$PATH" FAKE_RELEASE_MANIFEST="$manifest" FAKE_RELEASE_RUNNING=false \
  bash "$ROOT/installer/verify-release-images" "$manifest" "$TMP/install" "$TMP/data" >/dev/null 2>&1; then
  echo "release verifier accepted a stopped standalone Caddy" >&2; exit 1
fi

workflow="$ROOT/.github/workflows/release-images.yml"
grep -q 'group: release-images-promotion' "$workflow" || {
  echo "release promotion must be serialized across SHAs and versions" >&2
  exit 1
}
if grep -n '\${{ inputs\.version }}' "$workflow" | grep -q 'run:'; then
  echo "workflow input must not be interpolated directly into shell source" >&2
  exit 1
fi

# Exercise the installer's signature path without pulling real images.
source <(sed -n '/^verify_or_pull_images() {$/,/^}$/p' "$ROOT/installer/install.sh")
run() { "$@"; }
die() { echo "$1" >&2; exit "${2:-1}"; }
warn() { echo "$*" >&2; }
cat >"$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == "pull" ]]; then
  exit 0
elif [[ "$1" == "image" && "$2" == "inspect" ]]; then
  image="${@: -1}"
  printf '%s@sha256:%s\n' "${image%:*}" "$(printf 'b%.0s' {1..64})"
else
  echo "unexpected docker call: $*" >&2
  exit 2
fi
SH
cat >"$TMP/bin/cosign" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$FAKE_COSIGN_LOG"
SH
chmod +x "$TMP/bin/docker" "$TMP/bin/cosign"
export FAKE_COSIGN_LOG="$TMP/cosign.log"
DRY_RUN=0
PLOYDOK_INSTALL_SKIP_COSIGN=0
VERSION=test
IMAGE_REGISTRY=ghcr.io/dev-toolings
for identity in '' '^https://github\.com/example/fork/\.github/workflows/release-images\.yml@.*$'; do
  export PLOYDOK_COSIGN_IDENTITY_REGEXP="$identity"
  : >"$FAKE_COSIGN_LOG"
  PATH="$TMP/bin:$PATH" verify_or_pull_images
  expected_identity="${identity:-^https://github\.com/dev-toolings/ploydok/\.github/workflows/release-images\.yml@.*$}"
  [[ "$(grep -Fc -- "--certificate-identity-regexp $expected_identity" "$FAKE_COSIGN_LOG")" -eq 5 ]]
  [[ "$PLOYDOK_API_IMAGE" == "ghcr.io/dev-toolings/ploydok-api@$digest" ]]
done

echo "release image manifest tests OK"
