#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Ploydok one-line installer.
#
# Production usage requires the signed release bundle. Verify and extract it
# as an unprivileged user, then pass its COMMIT value when invoking this script
# with sudo. See README.md for the complete command sequence.
# Development-only edge usage is an explicit opt-in:
#   PLOYDOK_ALLOW_EDGE=1 PLOYDOK_REF=main curl .../main/installer/bootstrap.sh | sudo -E bash
#
# Once the install.ploydok.dev domain is live, the alias will be:
#   curl -fsSL https://install.ploydok.dev | sudo bash
#
set -Eeuo pipefail

REPO_URL="${PLOYDOK_REPO_URL:-https://github.com/dev-toolings/ploydok.git}"
REF="${PLOYDOK_REF:-}"
EXPECTED_COMMIT="${PLOYDOK_EXPECTED_COMMIT:-}"
ALLOW_EDGE="${PLOYDOK_ALLOW_EDGE:-0}"
WORK_DIR="${PLOYDOK_BOOTSTRAP_DIR:-/opt/ploydok-installer}"
DRY_RUN="${PLOYDOK_INSTALL_DRY_RUN:-0}"
COSIGN_VERSION="${PLOYDOK_COSIGN_VERSION:-v2.4.3}"

log() { printf '[ploydok-bootstrap] %s\n' "$*"; }
die() { printf '[ploydok-bootstrap] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

if [[ "$DRY_RUN" != "1" && "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "must run as root (use sudo)" 1
fi

command -v curl >/dev/null 2>&1 || die "curl is required" 3
command -v bash >/dev/null 2>&1 || die "bash is required" 3

validate_source() {
  if [[ "$ALLOW_EDGE" == "1" ]]; then
    REF="${REF:-main}"
  else
    [[ -n "$REF" ]] || die "PLOYDOK_REF is required; use an immutable release tag or commit" 2
    if [[ "$REF" =~ ^[0-9a-f]{40}$ && -z "$EXPECTED_COMMIT" ]]; then
      EXPECTED_COMMIT="$REF"
    fi
    [[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
      die "PLOYDOK_EXPECTED_COMMIT must be the 40-character release commit" 2
  fi

  [[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "invalid PLOYDOK_REF" 2
  [[ "$REF" != *".."* && "$REF" != *"@{"* ]] || die "invalid PLOYDOK_REF" 2
  case "$WORK_DIR" in
    ""|/|/opt|/usr|/var|/home) die "unsafe PLOYDOK_BOOTSTRAP_DIR: $WORK_DIR" 2 ;;
  esac
}

validate_source

install_base_dependencies() {
  command -v git >/dev/null 2>&1 && command -v envsubst >/dev/null 2>&1 && return
  if command -v apt-get >/dev/null 2>&1; then
    log "installing bootstrap dependencies"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates git gettext-base
    return
  fi
  die "git and envsubst are required (automatic installation supports apt-based hosts)" 3
}

install_cosign() {
  command -v cosign >/dev/null 2>&1 && return
  if [[ "${PLOYDOK_INSTALL_SKIP_COSIGN:-0}" == "1" ]]; then return; fi
  local arch asset tmp
  case "$(uname -m)" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "unsupported architecture for cosign: $(uname -m)" 3 ;;
  esac
  asset="cosign-linux-${arch}"
  tmp="$(mktemp -d)"
  (
    trap 'rm -rf "$tmp"' EXIT
    log "installing cosign ${COSIGN_VERSION}"
    curl -fsSL "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${asset}" -o "$tmp/$asset"
    curl -fsSL "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign_checksums.txt" -o "$tmp/cosign_checksums.txt"
    cd "$tmp"
    grep -E "[[:space:]]${asset}$" cosign_checksums.txt | sha256sum -c -
    install -m 0755 "$tmp/$asset" /usr/local/bin/cosign
  )
}

if [[ "$DRY_RUN" != "1" ]]; then
  install_base_dependencies
  install_cosign
fi

for bin in git envsubst; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin is required" 3
done

log "fetching $REPO_URL@$REF into $WORK_DIR"
if [[ -d "$WORK_DIR/.git" ]]; then
  git -C "$WORK_DIR" remote set-url origin "$REPO_URL"
  git -C "$WORK_DIR" fetch --depth 1 origin "$REF"
  git -C "$WORK_DIR" checkout -q FETCH_HEAD
else
  [[ ! -e "$WORK_DIR" ]] || die "$WORK_DIR exists but is not a Git checkout" 2
  mkdir -p "$WORK_DIR"
  git -C "$WORK_DIR" init -q
  git -C "$WORK_DIR" remote add origin "$REPO_URL"
  git -C "$WORK_DIR" fetch --depth 1 origin "$REF"
  git -C "$WORK_DIR" checkout -q FETCH_HEAD
fi

RESOLVED_COMMIT="$(git -C "$WORK_DIR" rev-parse HEAD)"
if [[ -n "$EXPECTED_COMMIT" && "$RESOLVED_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  die "release verification failed: expected $EXPECTED_COMMIT, resolved $RESOLVED_COMMIT" 5
fi
log "verified source commit $RESOLVED_COMMIT"

if [[ -z "${PLOYDOK_VERSION:-}" && "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  export PLOYDOK_VERSION="${REF#v}"
fi
if [[ "$ALLOW_EDGE" == "1" ]]; then
  export PLOYDOK_VERSION="${PLOYDOK_VERSION:-edge}"
else
  [[ -n "${PLOYDOK_VERSION:-}" ]] ||
    die "PLOYDOK_VERSION is required when PLOYDOK_REF is not a semantic release tag" 2
fi

log "running installer (forwarding $# args)"
exec bash "$WORK_DIR/installer/install.sh" "$@"
