#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

VERSION="${PLOYDOK_VERSION:-}"
MODE=""
RUNTIME="${PLOYDOK_RUNTIME:-swarm}"
HTTP_PORT="8080"
HTTPS_PORT="8443"
INSTALL_DIR="/opt/ploydok"
DATA_DIR="/var/lib/ploydok"
INSTALL_OWNER="${PLOYDOK_INSTALL_OWNER:-${SUDO_USER:-root}}"
IMAGE_REGISTRY="${PLOYDOK_IMAGE_REGISTRY:-ghcr.io/dev-toolings}"
PUBLIC_SCHEME="${PLOYDOK_PUBLIC_SCHEME:-}"
PUBLIC_HOST="${PLOYDOK_PUBLIC_HOST:-}"
PUBLIC_PORT="${PLOYDOK_PUBLIC_PORT:-}"
DOMAIN_BASE="${PLOYDOK_DOMAIN_BASE:-}"
PUBLIC_ORIGIN=""
SETUP_TOKEN_REQUIRED="${PLOYDOK_SETUP_TOKEN_REQUIRED:-}"
ALERT_WEBHOOK_URL="${PLOYDOK_ALERT_WEBHOOK_URL:-}"
SKIP_DOCKER_INSTALL=0
MANAGE_FIREWALL=0
YES=0
UNATTENDED=0
DRY_RUN="${PLOYDOK_INSTALL_DRY_RUN:-0}"
ROOT_PREFIX="${PLOYDOK_INSTALL_ROOT:-}"
LOG_DIR="/var/log/ploydok-install"
BACKUP_DIR="/var/backups/ploydok-install"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PREFLIGHT_LOG=""
PLOYDOK_API_IMAGE=""
PLOYDOK_WEB_IMAGE=""
PLOYDOK_AGENT_IMAGE=""
PLOYDOK_ADMINER_IMAGE=""
PLOYDOK_CADDY_IMAGE=""

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

Options:
  --mode=takeover|coexist|bootstrap-http|abort
  --http-port=8080
  --https-port=8443
  --install-dir=/opt/ploydok
  --data-dir=/var/lib/ploydok
  --public-host=<hostname-or-ip>
  --public-scheme=http|https
  --public-port=<port>
  --domain-base=<default-app-domain-suffix>
  --alert-webhook-url=<https-url> (optional HTTPS alert receiver; alerts are disabled when omitted)
  --skip-docker-install
  --manage-firewall
  --yes
  --unattended                 (implies --yes; defaults to coexist unless --mode is given)
  --version=<tag>
  --allow-edge                  (development only; permits the mutable edge channel)
  --image-registry=<registry>
  --runtime=swarm|compose      (default: swarm for production; compose is local/test only)
  --help

Environment for forks:
  PLOYDOK_IMAGE_REGISTRY=ghcr.io/dev-toolings
  PLOYDOK_COSIGN_IDENTITY_REGEXP=<trusted-release-workflow-regexp>

Environment for tests:
  PLOYDOK_INSTALL_DRY_RUN=1
  PLOYDOK_INSTALL_ROOT=/tmp/root
  PLOYDOK_INSTALL_OWNER=debian
  PLOYDOK_INSTALL_SKIP_COSIGN=1
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --mode=*) MODE="${arg#*=}" ;;
    --http-port=*) HTTP_PORT="${arg#*=}" ;;
    --https-port=*) HTTPS_PORT="${arg#*=}" ;;
    --install-dir=*) INSTALL_DIR="${arg#*=}" ;;
    --data-dir=*) DATA_DIR="${arg#*=}" ;;
    --public-host=*) PUBLIC_HOST="${arg#*=}" ;;
    --public-scheme=*) PUBLIC_SCHEME="${arg#*=}" ;;
    --public-port=*) PUBLIC_PORT="${arg#*=}" ;;
    --domain-base=*) DOMAIN_BASE="${arg#*=}" ;;
    --alert-webhook-url=*) ALERT_WEBHOOK_URL="${arg#*=}" ;;
    --skip-docker-install) SKIP_DOCKER_INSTALL=1 ;;
    --manage-firewall) MANAGE_FIREWALL=1 ;;
    --yes) YES=1 ;;
    --unattended) UNATTENDED=1; YES=1 ;;
    --version=*) VERSION="${arg#*=}" ;;
    --allow-edge)
      [[ -z "$VERSION" ]] && VERSION="edge"
      export PLOYDOK_ALLOW_EDGE=1
      ;;
    --image-registry=*) IMAGE_REGISTRY="${arg#*=}" ;;
    --runtime=*) RUNTIME="${arg#*=}" ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ "$UNATTENDED" == "1" && -z "$MODE" ]]; then
  MODE="coexist"
fi

case "$MODE" in
  ""|takeover|coexist|bootstrap-http|abort) ;;
  *) echo "Invalid --mode: $MODE" >&2; exit 1 ;;
esac

case "$RUNTIME" in
  swarm|compose) ;;
  *) echo "Invalid --runtime: $RUNTIME (expected swarm|compose)" >&2; exit 1 ;;
esac

case "$PUBLIC_SCHEME" in
  ""|http|https) ;;
  *) echo "Invalid --public-scheme: $PUBLIC_SCHEME" >&2; exit 1 ;;
esac

real_path() {
  local p="$1"
  if [[ -n "$ROOT_PREFIX" ]]; then
    printf '%s%s\n' "$ROOT_PREFIX" "$p"
  else
    printf '%s\n' "$p"
  fi
}

validate_alerting() {
  if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
    warn "alerting disabled: rerun with --alert-webhook-url=<https-url> or PLOYDOK_ALERT_WEBHOOK_URL to enable alerts (saved in $DATA_DIR/secrets/alert-webhook-url)"
    return 0
  fi
  [[ "$ALERT_WEBHOOK_URL" =~ ^https://[^[:space:]]+$ ]] ||
    die "--alert-webhook-url (or PLOYDOK_ALERT_WEBHOOK_URL) must be an HTTPS Alertmanager-compatible receiver" 2
  [[ "$ALERT_WEBHOOK_URL" != *$'\n'* && "$ALERT_WEBHOOK_URL" != *$'\r'* ]] ||
    die "alert webhook URL contains an invalid newline" 2
}

render_alertmanager() {
  if [[ -n "$ALERT_WEBHOOK_URL" ]]; then
    render_template alertmanager.yml
  else
    cat <<'YAML'
# ploydok-monitoring-schema: 1
# Alerting disabled; monitoring remains available.
route:
  receiver: disabled
receivers:
  - name: disabled
YAML
  fi
}

load_existing_alerting() {
  local existing
  [[ -z "$ALERT_WEBHOOK_URL" ]] || return 0
  existing="$(real_path "$DATA_DIR/secrets/alert-webhook-url")"
  if [[ -f "$existing" ]]; then
    ALERT_WEBHOOK_URL="$(<"$existing")"
  fi
}

install_dir() {
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd
}

log() { printf '[ploydok-install] %s\n' "$*"; }
warn() { printf '[ploydok-install] WARN: %s\n' "$*" >&2; }
die() { printf '[ploydok-install] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: $*"
  else
    "$@"
  fi
}

write_file() {
  local target="$1"
  local mode="$2"
  local owner="${3:-}"
  local tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  install -D -m "$mode" "$tmp" "$(real_path "$target")"
  rm -f "$tmp"
  if [[ -n "$owner" && "$DRY_RUN" != "1" && -z "$ROOT_PREFIX" ]]; then
    chown "$owner" "$target"
  fi
}

render_template() {
  local template="$1"
  local public_host="${PUBLIC_HOST:-localhost}"
  local caddy_admin_address="0.0.0.0:2019"
  local control_plane_hosts="localhost ploydok.local"
  local control_plane_site
  if [[ "$RUNTIME" == "swarm" ]]; then
    caddy_admin_address="unix//run/caddy-admin/admin.sock|0660"
  fi
  case "$public_host" in
    localhost) control_plane_hosts="ploydok.local" ;;
    ploydok.local) control_plane_hosts="localhost" ;;
    *) control_plane_hosts="$control_plane_hosts $public_host" ;;
  esac
  printf -v control_plane_site '%s://%s {\n\timport control_plane\n}' "${PUBLIC_SCHEME:-https}" "$public_host"
  PLOYDOK_VERSION="$VERSION" \
  PLOYDOK_MODE="$MODE" \
  PLOYDOK_IMAGE_REGISTRY="$IMAGE_REGISTRY" \
  PLOYDOK_INSTALL_DIR="$INSTALL_DIR" \
  PLOYDOK_DATA_DIR="$DATA_DIR" \
  PLOYDOK_HTTP_PORT="$HTTP_PORT" \
  PLOYDOK_HTTPS_PORT="$HTTPS_PORT" \
  PLOYDOK_HTTP_PUBLISHED_PORT="$HTTP_PUBLISHED_PORT" \
  PLOYDOK_HTTPS_PUBLISHED_PORT="$HTTPS_PUBLISHED_PORT" \
  PLOYDOK_HTTP_BIND="$HTTP_BIND" \
  PLOYDOK_HTTPS_BIND="$HTTPS_BIND" \
  PLOYDOK_PUBLIC_HOST="$public_host" \
  PLOYDOK_PUBLIC_SCHEME="${PUBLIC_SCHEME:-https}" \
  PLOYDOK_CADDY_ADMIN_ADDRESS="$caddy_admin_address" \
  PLOYDOK_API_IMAGE="${PLOYDOK_API_IMAGE:-$IMAGE_REGISTRY/ploydok-api:$VERSION}" \
  PLOYDOK_WEB_IMAGE="${PLOYDOK_WEB_IMAGE:-$IMAGE_REGISTRY/ploydok-web:$VERSION}" \
  PLOYDOK_AGENT_IMAGE="${PLOYDOK_AGENT_IMAGE:-$IMAGE_REGISTRY/ploydok-agent:$VERSION}" \
  PLOYDOK_ADMINER_IMAGE="${PLOYDOK_ADMINER_IMAGE:-$IMAGE_REGISTRY/ploydok-adminer:$VERSION}" \
  PLOYDOK_CADDY_IMAGE="${PLOYDOK_CADDY_IMAGE:-$IMAGE_REGISTRY/ploydok-caddy:$VERSION}" \
  PLOYDOK_CONTROL_PLANE_SITE="$control_plane_site" \
  PLOYDOK_CONTROL_PLANE_HOSTS="$control_plane_hosts" \
  envsubst '$PLOYDOK_VERSION $PLOYDOK_MODE $PLOYDOK_IMAGE_REGISTRY $PLOYDOK_API_IMAGE $PLOYDOK_WEB_IMAGE $PLOYDOK_AGENT_IMAGE $PLOYDOK_ADMINER_IMAGE $PLOYDOK_CADDY_IMAGE $PLOYDOK_INSTALL_DIR $PLOYDOK_DATA_DIR $PLOYDOK_HTTP_PORT $PLOYDOK_HTTPS_PORT $PLOYDOK_HTTP_PUBLISHED_PORT $PLOYDOK_HTTPS_PUBLISHED_PORT $PLOYDOK_HTTP_BIND $PLOYDOK_HTTPS_BIND $PLOYDOK_PUBLIC_HOST $PLOYDOK_PUBLIC_SCHEME $PLOYDOK_CADDY_ADMIN_ADDRESS $PLOYDOK_CONTROL_PLANE_SITE $PLOYDOK_CONTROL_PLANE_HOSTS' <"$(install_dir)/templates/$template"
}

detect_public_host() {
  local first_ip
  first_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  printf '%s\n' "${first_ip:-localhost}"
}

build_public_origin() {
  local scheme="$1" host="$2" port="$3"
  if [[ -n "$port" && !( "$scheme" == "http" && "$port" == "80" ) && !( "$scheme" == "https" && "$port" == "443" ) ]]; then
    printf '%s://%s:%s\n' "$scheme" "$host" "$port"
  else
    printf '%s://%s\n' "$scheme" "$host"
  fi
}

derive_domain_base() {
  local host="$1"
  if [[ -n "$DOMAIN_BASE" ]]; then
    printf '%s\n' "$DOMAIN_BASE"
    return
  fi

  if [[ "$host" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    printf '%s.sslip.io\n' "${host//./-}"
    return
  fi

  case "$host" in
    ""|localhost|*.local) printf 'demo.ploydok.local\n' ;;
    *) printf 'apps.%s\n' "$host" ;;
  esac
}

resolve_public_endpoint() {
  if [[ -z "$PUBLIC_SCHEME" ]]; then
    if [[ "$MODE" == "bootstrap-http" ]]; then
      PUBLIC_SCHEME="http"
    else
      PUBLIC_SCHEME="https"
    fi
  fi

  if [[ -z "$PUBLIC_HOST" ]]; then
    if [[ "$MODE" == "bootstrap-http" ]]; then
      PUBLIC_HOST="$(detect_public_host)"
    else
      PUBLIC_HOST="localhost"
    fi
  fi

  if [[ -z "$PUBLIC_PORT" && "$MODE" == "bootstrap-http" ]]; then
    PUBLIC_PORT="$HTTP_PORT"
  fi

  # Default matches Coolify, Dokploy and OpenShip: /setup is a registration
  # form until the first admin exists. Set PLOYDOK_SETUP_TOKEN_REQUIRED=1 to
  # keep the one-shot token lock.
  if [[ -z "$SETUP_TOKEN_REQUIRED" ]]; then
    SETUP_TOKEN_REQUIRED="0"
  fi

  DOMAIN_BASE="$(derive_domain_base "$PUBLIC_HOST")"
  PUBLIC_ORIGIN="$(build_public_origin "$PUBLIC_SCHEME" "$PUBLIC_HOST" "$PUBLIC_PORT")"
}

require_root() {
  if [[ "$DRY_RUN" == "1" || -n "$ROOT_PREFIX" ]]; then return; fi
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "installer must run as root" 1
  fi
}

version_ge() {
  local have="$1" need="$2"
  [[ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -n1)" == "$need" ]]
}

kernel_version() { uname -r | sed 's/[^0-9.].*$//'; }
total_mem_mb() { awk '/MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0; }
free_disk_mb() { df -Pm / | awk 'NR==2 {print $4}' 2>/dev/null || echo 0; }
docker_major() { docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1 || true; }

read_env_value() {
  local file="$1" key="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

append_env_if_missing() {
  local file="$1" key="$2" value="$3"
  if ! grep -Eq "^${key}=" "$file" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

replace_env_if_equals() {
  local file="$1" key="$2" expected="$3" replacement="$4"
  local current
  current="$(read_env_value "$file" "$key")"
  if [[ "$current" == "$expected" ]]; then
    sed -i -E "s#^${key}=.*#${key}=${replacement}#" "$file"
  fi
}

list_port_listeners() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print}'
  else
    true
  fi
}

active_proxy_services() {
  local svc
  for svc in nginx apache2 caddy traefik haproxy; do
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$svc"; then
      echo "$svc"
    fi
  done
}

preflight() {
  mkdir -p "$(real_path "$LOG_DIR")"
  PREFLIGHT_LOG="$(real_path "$LOG_DIR/preflight-$TIMESTAMP.log")"
  {
    echo "timestamp=$TIMESTAMP"
    echo "kernel=$(uname -r)"
    echo "arch=$(uname -m)"
    echo "mode=${MODE:-interactive}"
    echo "install_dir=$INSTALL_DIR"
    echo "data_dir=$DATA_DIR"
    echo "port_listeners_start"
    list_port_listeners || true
    echo "port_listeners_end"
    echo "active_proxy_services=$(active_proxy_services | paste -sd, -)"
    echo "docker_containers=$(docker ps -a --filter 'name=ploydok-*' --format '{{.Names}}' 2>/dev/null | paste -sd, -)"
    echo "firewall=$(command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -n1 || true)"
    echo "selinux=$(command -v getenforce >/dev/null 2>&1 && getenforce || true)"
    echo "apparmor=$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true)"
    echo "timezone=$(timedatectl show -p Timezone --value 2>/dev/null || true)"
    echo "ntp=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
  } >"$PREFLIGHT_LOG"

  version_ge "$(kernel_version)" "5.10" || die "Linux kernel >= 5.10 required" 3
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die "unsupported architecture: $(uname -m)" 3 ;; esac
  command -v systemctl >/dev/null 2>&1 || die "systemd is required" 3
  command -v openssl >/dev/null 2>&1 || die "openssl is required" 3
  command -v envsubst >/dev/null 2>&1 || die "envsubst is required (install gettext-base)" 3
  command -v curl >/dev/null 2>&1 || die "curl is required" 3
  [[ -d /run/systemd/system || "$DRY_RUN" == "1" || -n "$ROOT_PREFIX" ]] || die "systemd is not running" 3

  if [[ -r /proc/sys/kernel/unprivileged_userns_clone ]]; then
    [[ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" == "1" ]] || die "unprivileged user namespaces must be enabled" 3
  fi

  if ! command -v docker >/dev/null 2>&1; then
    if [[ "$SKIP_DOCKER_INSTALL" == "1" ]]; then
      die "Docker is missing and --skip-docker-install was set" 3
    fi
    install_docker
  fi
  local major
  major="$(docker_major)"
  [[ -n "$major" && "$major" -ge 24 ]] || die "Docker server >= 24 is required" 3
  if [[ "$RUNTIME" == "swarm" ]]; then
    command -v iptables >/dev/null 2>&1 ||
      die "iptables is required to isolate Swarm published ports" 3
  fi

  [[ "$(total_mem_mb)" -ge 2048 ]] || die "at least 2 GB RAM is required" 3
  [[ "$(free_disk_mb)" -ge 10240 ]] || die "at least 10 GB free disk is required" 3
  [[ "$(total_mem_mb)" -ge 4096 ]] || warn "less than 4 GB RAM available"
  [[ "$(free_disk_mb)" -ge 20480 ]] || warn "less than 20 GB free disk available"

  log "preflight report: $PREFLIGHT_LOG"
}

has_port_conflict() {
  [[ -n "$(list_port_listeners)" ]]
}

choose_mode() {
  if [[ "$MODE" == "abort" ]]; then
    log "mode=abort requested; no changes will be made"
    exit 2
  fi
  if [[ -n "$MODE" ]]; then return; fi
  if ! has_port_conflict; then
    MODE="takeover"
    return
  fi
  if [[ "$YES" == "1" ]]; then
    die "ports 80/443 are occupied and no --mode was provided" 4
  fi
  echo "Ports 80/443 are occupied. Choose: [T]akeover, [C]oexist, [A]bort" >&2
  read -r answer
  case "${answer,,}" in
    t|takeover) MODE="takeover" ;;
    c|coexist) MODE="coexist" ;;
    *) exit 2 ;;
  esac
}

validate_release_channel() {
  [[ -n "$VERSION" ]] ||
    die "--version is required; use --allow-edge only for development evaluation" 2
  if [[ "$VERSION" == "edge" && "${PLOYDOK_ALLOW_EDGE:-0}" != "1" ]]; then
    die "the mutable edge channel requires PLOYDOK_ALLOW_EDGE=1" 2
  fi
}

configure_binds() {
  if [[ "$MODE" == "coexist" ]]; then
    HTTP_BIND="127.0.0.1:${HTTP_PORT}"
    HTTPS_BIND="127.0.0.1:${HTTPS_PORT}"
    HTTP_PUBLISHED_PORT="$HTTP_PORT"
    HTTPS_PUBLISHED_PORT="$HTTPS_PORT"
  elif [[ "$MODE" == "bootstrap-http" ]]; then
    HTTP_BIND="0.0.0.0:${HTTP_PORT}"
    HTTPS_BIND="127.0.0.1:${HTTPS_PORT}"
    HTTP_PUBLISHED_PORT="$HTTP_PORT"
    HTTPS_PUBLISHED_PORT="$HTTPS_PORT"
  else
    HTTP_BIND="80"
    HTTPS_BIND="443"
    HTTP_PUBLISHED_PORT="80"
    HTTPS_PUBLISHED_PORT="443"
  fi
}

backup_proxy_configs() {
  mkdir -p "$(real_path "$BACKUP_DIR")"
  local svc
  for svc in nginx apache2 caddy traefik haproxy; do
    local src="/etc/$svc"
    if [[ -d "$src" ]]; then
      run tar -czf "$(real_path "$BACKUP_DIR/$svc-$TIMESTAMP.tar.gz")" -C "$(dirname "$src")" "$(basename "$src")"
    fi
  done
}

takeover_proxy() {
  [[ "$MODE" == "takeover" ]] || return 0
  backup_proxy_configs
  local svc
  for svc in $(active_proxy_services); do
    run systemctl stop "$svc"
    run systemctl disable "$svc"
  done
}

create_system_user() {
  if id ploydok >/dev/null 2>&1; then return; fi
  run useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin ploydok
}

create_directories() {
  local dir stamp stamp_path
  install -d -m 0750 "$(real_path "$INSTALL_DIR")"
  for dir in data builds backups storage volumes app-volumes certs pki keys logs agent config secrets static caddy-ip-cert; do
    install -d -m 0750 "$(real_path "$DATA_DIR/$dir")"
  done
  for stamp in control-plane.configured control-plane.last-success control-plane.last-failure; do
    stamp_path="$(real_path "$DATA_DIR/backups/$stamp")"
    if [[ ! -e "$stamp_path" ]]; then
      install -m 0444 /dev/null "$stamp_path"
      touch -d @0 "$stamp_path"
    fi
  done
  if [[ "$DRY_RUN" != "1" && -z "$ROOT_PREFIX" ]]; then
    chown "$INSTALL_OWNER:$INSTALL_OWNER" "$INSTALL_DIR"
    chown -R ploydok:ploydok "$DATA_DIR"
  fi
}

generate_secrets() {
  local master_key pg_pass redis_pass session_secret metrics_token public_scheme public_host public_port domain_base
  local runtime_uid=1000 runtime_gid=1000
  local public_origin public_port_line master_path env_path
  master_path="$(real_path "$DATA_DIR/master.key")"
  env_path="$(real_path "$DATA_DIR/.env")"
  public_scheme="$PUBLIC_SCHEME"
  public_host="$PUBLIC_HOST"
  public_port="$PUBLIC_PORT"
  domain_base="$DOMAIN_BASE"
  public_origin="$PUBLIC_ORIGIN"
  if id ploydok >/dev/null 2>&1; then
    runtime_uid="$(id -u ploydok)"
    runtime_gid="$(id -g ploydok)"
  fi
  public_port_line=""
  [[ -n "$public_port" ]] && public_port_line="PLOYDOK_PUBLIC_PORT=${public_port}"

  if [[ -f "$env_path" ]]; then
    master_key="$(read_env_value "$env_path" MASTER_KEY)"
    if [[ -n "$master_key" && ! -f "$master_path" ]]; then
      write_file "$DATA_DIR/master.key" 0400 ploydok:ploydok <<<"$master_key"
    fi
    append_env_if_missing "$env_path" WEB_ORIGIN "$public_origin"
    append_env_if_missing "$env_path" GITHUB_APP_CALLBACK_URL "$public_origin/github/app/callback"
    append_env_if_missing "$env_path" GITLAB_OAUTH_CALLBACK_URL "$public_origin/gitlab/callback"
    append_env_if_missing "$env_path" PLOYDOK_PUBLIC_SCHEME "$public_scheme"
    append_env_if_missing "$env_path" PLOYDOK_PUBLIC_HOST "$public_host"
    append_env_if_missing "$env_path" PLOYDOK_DOMAIN_BASE "$domain_base"
    if [[ -n "$public_port" ]]; then
      append_env_if_missing "$env_path" PLOYDOK_PUBLIC_PORT "$public_port"
    fi
    append_env_if_missing "$env_path" PLOYDOK_SETUP_TOKEN_REQUIRED "$SETUP_TOKEN_REQUIRED"
    append_env_if_missing "$env_path" PLOYDOK_COOKIE_SECURE "auto"
    append_env_if_missing "$env_path" PLOYDOK_TRUST_PROXY_HEADERS "true"
    append_env_if_missing "$env_path" PLOYDOK_REGISTRY_URL "127.0.0.1:5000"
    append_env_if_missing "$env_path" PLOYDOK_REGISTRY_API_URL "registry:5000"
    append_env_if_missing "$env_path" PLOYDOK_REGISTRY_PUSH_URL "registry:5000"
    append_env_if_missing "$env_path" PLOYDOK_IMAGE_REGISTRY "$IMAGE_REGISTRY"
    append_env_if_missing "$env_path" PLOYDOK_ALLOW_EDGE "${PLOYDOK_ALLOW_EDGE:-0}"
    append_env_if_missing "$env_path" PLOYDOK_ENABLE_AUTO_UPDATES "${PLOYDOK_ENABLE_AUTO_UPDATES:-0}"
    replace_env_if_equals "$env_path" PLOYDOK_REGISTRY_URL "registry:5000" "127.0.0.1:5000"
    append_env_if_missing "$env_path" PLOYDOK_BUILDKIT_ADDR "tcp://buildkitd:1234"
    append_env_if_missing "$env_path" PLOYDOK_BUILD_DIR "/var/lib/ploydok/builds"
    append_env_if_missing "$env_path" PLOYDOK_STATIC_ROOT "/var/lib/ploydok/static"
    append_env_if_missing "$env_path" PLOYDOK_LOCAL_STORAGE_DIR "/var/lib/ploydok/storage"
    if [[ "$RUNTIME" == "swarm" ]]; then
      append_env_if_missing "$env_path" CADDY_ADMIN_URL "http://caddy-admin:2019"
      replace_env_if_equals "$env_path" CADDY_ADMIN_URL "http://caddy:2019" "http://caddy-admin:2019"
    else
      append_env_if_missing "$env_path" CADDY_ADMIN_URL "http://caddy:2019"
    fi
    append_env_if_missing "$env_path" PLOYDOK_AGENT_ADDR "agent:50051"
    append_env_if_missing "$env_path" PLOYDOK_AGENT_CA "/var/lib/ploydok/pki/ca.pem"
    append_env_if_missing "$env_path" PLOYDOK_AGENT_CLIENT_CERT "/var/lib/ploydok/pki/client.pem"
    append_env_if_missing "$env_path" PLOYDOK_AGENT_CLIENT_KEY "/var/lib/ploydok/pki/client.key"
    append_env_if_missing "$env_path" PLOYDOK_RUNTIME_UID "$runtime_uid"
    append_env_if_missing "$env_path" PLOYDOK_RUNTIME_GID "$runtime_gid"
    metrics_token="$(read_env_value "$env_path" PLOYDOK_METRICS_TOKEN)"
    if [[ -z "$metrics_token" ]]; then
      metrics_token="$(openssl rand -hex 32)"
      append_env_if_missing "$env_path" PLOYDOK_METRICS_TOKEN "$metrics_token"
    fi
    write_file "$DATA_DIR/secrets/metrics-token" 0400 65534:65534 <<<"$metrics_token"
    write_file "$DATA_DIR/secrets/alert-webhook-url" 0400 65534:65534 <<<"$ALERT_WEBHOOK_URL"
    log "existing $DATA_DIR/.env preserved"
    return
  fi

  if [[ -f "$master_path" ]]; then
    master_key="$(cat "$master_path")"
  else
    master_key="$(openssl rand -base64 32)"
    write_file "$DATA_DIR/master.key" 0400 ploydok:ploydok <<<"$master_key"
  fi

  pg_pass="$(openssl rand -hex 32)"
  redis_pass="$(openssl rand -hex 32)"
  session_secret="$(openssl rand -hex 32)"
  metrics_token="$(openssl rand -hex 32)"
  write_file "$DATA_DIR/.env" 0600 ploydok:ploydok <<EOF
NODE_ENV=prod
PORT=3335
DATABASE_URL=postgres://ploydok:${pg_pass}@postgres:5432/ploydok
REDIS_URL=redis://:${redis_pass}@redis:6379/0
PLOYDOK_PG_PASSWORD=${pg_pass}
PLOYDOK_REDIS_PASSWORD=${redis_pass}
SESSION_SECRET=${session_secret}
MASTER_KEY=${master_key}
PLOYDOK_METRICS_TOKEN=${metrics_token}
WEB_ORIGIN=${public_origin}
GITHUB_APP_CALLBACK_URL=${public_origin}/github/app/callback
GITLAB_OAUTH_CALLBACK_URL=${public_origin}/gitlab/callback
PLOYDOK_PUBLIC_SCHEME=${public_scheme}
PLOYDOK_PUBLIC_HOST=${public_host}
PLOYDOK_DOMAIN_BASE=${domain_base}
${public_port_line}
PLOYDOK_SETUP_TOKEN_REQUIRED=${SETUP_TOKEN_REQUIRED}
PLOYDOK_COOKIE_SECURE=auto
PLOYDOK_TRUST_PROXY_HEADERS=true
PLOYDOK_REGISTRY_URL=127.0.0.1:5000
PLOYDOK_REGISTRY_API_URL=registry:5000
PLOYDOK_REGISTRY_PUSH_URL=registry:5000
PLOYDOK_IMAGE_REGISTRY=$IMAGE_REGISTRY
PLOYDOK_ALLOW_EDGE=${PLOYDOK_ALLOW_EDGE:-0}
PLOYDOK_ENABLE_AUTO_UPDATES=${PLOYDOK_ENABLE_AUTO_UPDATES:-0}
PLOYDOK_BUILDKIT_ADDR=tcp://buildkitd:1234
PLOYDOK_BUILD_DIR=/var/lib/ploydok/builds
PLOYDOK_STATIC_ROOT=/var/lib/ploydok/static
PLOYDOK_LOCAL_STORAGE_DIR=/var/lib/ploydok/storage
CADDY_ADMIN_URL=$([[ "$RUNTIME" == "swarm" ]] && printf 'http://caddy-admin:2019' || printf 'http://caddy:2019')
PLOYDOK_AGENT_ADDR=agent:50051
PLOYDOK_AGENT_CA=/var/lib/ploydok/pki/ca.pem
PLOYDOK_AGENT_CLIENT_CERT=/var/lib/ploydok/pki/client.pem
PLOYDOK_AGENT_CLIENT_KEY=/var/lib/ploydok/pki/client.key
PLOYDOK_RUNTIME_UID=${runtime_uid}
PLOYDOK_RUNTIME_GID=${runtime_gid}
EOF
  write_file "$DATA_DIR/secrets/metrics-token" 0400 65534:65534 <<<"$metrics_token"
  write_file "$DATA_DIR/secrets/alert-webhook-url" 0400 65534:65534 <<<"$ALERT_WEBHOOK_URL"
}

generate_mtls() {
  local cert_dir
  cert_dir="$(real_path "$DATA_DIR/certs")"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: generate mTLS certs in $cert_dir"
    return
  fi
  openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
    -keyout "$cert_dir/ca.key" -out "$cert_dir/ca.crt" \
    -subj "/CN=Ploydok local CA" >/dev/null 2>&1
  openssl req -newkey rsa:4096 -nodes \
    -keyout "$cert_dir/agent.key" -out "$cert_dir/agent.csr" \
    -subj "/CN=ploydok-agent" >/dev/null 2>&1
  openssl x509 -req -in "$cert_dir/agent.csr" -CA "$cert_dir/ca.crt" \
    -CAkey "$cert_dir/ca.key" -CAcreateserial -out "$cert_dir/agent.crt" \
    -days 3650 >/dev/null 2>&1
}

# PKI partagée entre l'agent (server gRPC mTLS) et l'API (client mTLS).
# Idempotent : si ca.pem existe, on ne régénère rien (préserve les certs entre
# re-installs). Les fichiers ca.pem/server.pem/server.key/client.pem/client.key
# sont les noms attendus par `pki::ensure_pki()` côté agent Rust ; les alias
# .crt/.key facilitent les références humaines et certaines libs TLS.
generate_agent_pki() {
  local pki_dir
  pki_dir="$(real_path "$DATA_DIR/pki")"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: generate agent PKI in $pki_dir"
    return
  fi

  if [[ -f "$pki_dir/ca.pem" && -f "$pki_dir/server.pem" && -f "$pki_dir/client.pem" ]]; then
    log "existing $pki_dir preserved"
    return
  fi

  local tmp_ext tmp_client_ext
  tmp_ext="$(mktemp)"
  tmp_client_ext="$(mktemp)"
  cat >"$tmp_ext" <<'EOF'
[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = agent
DNS.2 = ploydok-agent
DNS.3 = localhost
EOF
  cat >"$tmp_client_ext" <<'EOF'
[v3_client]
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
EOF

  # CA (10 ans)
  openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
    -keyout "$pki_dir/ca.key" -out "$pki_dir/ca.crt" \
    -subj "/CN=Ploydok agent CA" >/dev/null 2>&1

  # Cert serveur agent (CN=ploydok-agent, SAN DNS:agent + DNS:localhost)
  openssl req -newkey rsa:4096 -nodes \
    -keyout "$pki_dir/agent.key" -out "$pki_dir/agent.csr" \
    -subj "/CN=ploydok-agent" >/dev/null 2>&1
  openssl x509 -req -in "$pki_dir/agent.csr" \
    -CA "$pki_dir/ca.crt" -CAkey "$pki_dir/ca.key" -CAcreateserial \
    -out "$pki_dir/agent.crt" -days 365 \
    -extensions v3_req -extfile "$tmp_ext" >/dev/null 2>&1
  rm -f "$pki_dir/agent.csr"

  # Cert client API (CN=ploydok-api)
  openssl req -newkey rsa:4096 -nodes \
    -keyout "$pki_dir/api-client.key" -out "$pki_dir/api-client.csr" \
    -subj "/CN=ploydok-api" >/dev/null 2>&1
  openssl x509 -req -in "$pki_dir/api-client.csr" \
    -CA "$pki_dir/ca.crt" -CAkey "$pki_dir/ca.key" -CAcreateserial \
    -out "$pki_dir/api-client.crt" -days 365 \
    -extensions v3_client -extfile "$tmp_client_ext" >/dev/null 2>&1
  rm -f "$pki_dir/api-client.csr"

  rm -f "$tmp_ext" "$tmp_client_ext"

  # Aliases attendus par pki::ensure_pki côté agent
  cp -f "$pki_dir/ca.crt" "$pki_dir/ca.pem"
  cp -f "$pki_dir/agent.crt" "$pki_dir/server.pem"
  cp -f "$pki_dir/agent.key" "$pki_dir/server.key"
  cp -f "$pki_dir/api-client.crt" "$pki_dir/client.pem"
  cp -f "$pki_dir/api-client.key" "$pki_dir/client.key"

  if [[ -z "$ROOT_PREFIX" ]]; then
    chown -R ploydok:ploydok "$pki_dir"
  fi
  chmod 0640 "$pki_dir"/*.crt "$pki_dir"/*.pem
  chmod 0600 "$pki_dir"/*.key
}

install_docker() {
  log "Docker not found; installing via get.docker.com (skip with --skip-docker-install)"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: curl -fsSL https://get.docker.com | sh"
    return
  fi
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
  command -v docker >/dev/null 2>&1 || die "Docker installation failed" 3
}

prepare_runtime_transition() {
  local compose_file stack_file env_file
  compose_file="$(real_path "$INSTALL_DIR/docker-compose.yml")"
  stack_file="$(real_path "$INSTALL_DIR/docker-stack.yml")"
  env_file="$(real_path "$DATA_DIR/.env")"

  if [[ "$RUNTIME" == "compose" && -f "$stack_file" ]]; then
    die "refusing to replace an existing production Swarm stack with Compose; uninstall the Swarm runtime first" 2
  fi

  [[ "$RUNTIME" == "swarm" && -f "$compose_file" ]] || return 0
  log "migrating the control plane runtime from Compose to Swarm (named volumes are preserved)"
  if [[ ! -f "$stack_file" && "$DRY_RUN" != "1" ]] &&
    systemctl is-active --quiet ploydok.service; then
    run systemctl stop ploydok.service
  fi
  [[ -f "$env_file" ]] || die "cannot migrate Compose to Swarm: missing $env_file" 2
  run docker compose --env-file "$env_file" -f "$compose_file" down
}

# Initialise un Swarm single-node si la machine n'en fait pas déjà partie.
# Existing Swarms must have the supported single-node topology. Keep one
# previous task alongside the current task for diagnosis with fewer pinned images.
ensure_swarm() {
  [[ "$RUNTIME" == "swarm" ]] || return 0
  local state
  state="$(docker info --format '{{ .Swarm.LocalNodeState }}' 2>/dev/null || echo inactive)"
  if [[ "$state" == "active" ]]; then
    local node_count
    node_count="$(docker node ls --format '{{.ID}}' 2>/dev/null | grep -c . || true)"
    [[ "$node_count" -eq 1 ]] ||
      die "Ploydok currently supports exactly one Swarm node; detected ${node_count:-an unverifiable topology}" 3
    log "Docker Swarm already active with the supported single-node topology"
  elif [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: docker swarm init"
  else
    local advertise
    advertise="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    if [[ -n "$advertise" ]]; then
      log "Initialising Docker Swarm (single-node, advertise-addr=$advertise)"
      run docker swarm init --advertise-addr "$advertise"
    else
      log "Initialising Docker Swarm (single-node)"
      run docker swarm init
    fi
  fi
  run docker swarm update --task-history-limit 2
}

install_cli() {
  local src
  src="$(install_dir)/ploydok-cli"
  if [[ -f "$src" ]]; then
    install -D -m 0755 "$src" "$(real_path /usr/local/bin/ploydok-cli)"
  fi
  src="$(install_dir)/ploydok-dr"
  if [[ -f "$src" ]]; then
    install -D -m 0755 "$src" "$(real_path /usr/local/lib/ploydok/ploydok-dr)"
  fi
  src="$(install_dir)/migrate-stack-descriptor"
  if [[ -f "$src" ]]; then
    install -D -m 0755 "$src" "$(real_path /usr/local/lib/ploydok/migrate-stack-descriptor)"
  fi
  src="$(install_dir)/verify-restored-platform"
  if [[ -f "$src" ]]; then
    install -D -m 0755 "$src" "$(real_path /usr/local/lib/ploydok/verify-restored-platform)"
  fi
}

# Vérifie la signature keyless OIDC des images publiées par
# .github/workflows/release-images.yml. Identité attendue :
#   issuer   : https://token.actions.githubusercontent.com
#   identity : https://github.com/dev-toolings/ploydok/.github/workflows/release-images.yml@<ref>
# Bypass (CI / dry-run / image registry custom non signé) : PLOYDOK_INSTALL_SKIP_COSIGN=1.
verify_or_pull_images() {
  local components=(api web agent adminer caddy)
  local cosign_identity_regex='^https://github\.com/dev-toolings/ploydok/\.github/workflows/release-images\.yml@.*$'
  cosign_identity_regex="${PLOYDOK_COSIGN_IDENTITY_REGEXP:-$cosign_identity_regex}"
  local component image resolved
  for component in "${components[@]}"; do
    image="$IMAGE_REGISTRY/ploydok-${component}:$VERSION"
    if [[ "$DRY_RUN" == "1" || "${PLOYDOK_INSTALL_SKIP_COSIGN:-0}" == "1" ]]; then
      warn "image signature verification skipped for $image (PLOYDOK_INSTALL_SKIP_COSIGN=1 or dry-run)"
      run docker pull "$image"
      resolved="$image"
    elif command -v cosign >/dev/null 2>&1; then
      run docker pull "$image"
      resolved="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" | grep -F "${IMAGE_REGISTRY}/ploydok-${component}@sha256:" | head -n1)"
      [[ "$resolved" =~ @sha256:[0-9a-f]{64}$ ]] ||
        die "could not resolve an immutable digest for $image" 5
      run cosign verify \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com \
        --certificate-identity-regexp "$cosign_identity_regex" \
        "$resolved"
    else
      die "cosign is required to verify $image (set PLOYDOK_INSTALL_SKIP_COSIGN=1 only for controlled test installs)" 3
    fi

    case "$component" in
      api) PLOYDOK_API_IMAGE="$resolved" ;;
      web) PLOYDOK_WEB_IMAGE="$resolved" ;;
      agent) PLOYDOK_AGENT_IMAGE="$resolved" ;;
      adminer) PLOYDOK_ADMINER_IMAGE="$resolved" ;;
      caddy) PLOYDOK_CADDY_IMAGE="$resolved" ;;
    esac
  done
}

write_templates() {
  if [[ "$RUNTIME" == "swarm" ]]; then
    render_template docker-stack.yml | write_file "$INSTALL_DIR/docker-stack.yml" 0640 "$INSTALL_OWNER:$INSTALL_OWNER"
    render_template Caddyfile | write_file "$INSTALL_DIR/Caddyfile" 0644 "$INSTALL_OWNER:$INSTALL_OWNER"
    render_template CaddyAdminProxyfile | write_file "$INSTALL_DIR/CaddyAdminProxyfile" 0644 "$INSTALL_OWNER:$INSTALL_OWNER"
    render_template ploydok-port-isolation.sh | write_file "/usr/local/lib/ploydok/port-isolation.sh" 0755
    render_template ploydok-stop-stack.sh | write_file "/usr/local/lib/ploydok/stop-stack.sh" 0755
    render_template ploydok-update-stack.sh | write_file "/usr/local/lib/ploydok/update-stack.sh" 0755
    render_template ploydok-port-isolation.service | write_file "/etc/systemd/system/ploydok-port-isolation.service" 0644
    render_template ploydok.service | write_file "/etc/systemd/system/ploydok.service" 0644
    render_template ploydok-update.service | write_file "/etc/systemd/system/ploydok-update.service" 0644
    render_template ploydok-update.timer | write_file "/etc/systemd/system/ploydok-update.timer" 0644
  else
    render_template docker-compose.yml | write_file "$INSTALL_DIR/docker-compose.yml" 0640 "$INSTALL_OWNER:$INSTALL_OWNER"
    render_template Caddyfile | write_file "$INSTALL_DIR/Caddyfile" 0644 "$INSTALL_OWNER:$INSTALL_OWNER"
    render_template ploydok-compose.service | write_file "/etc/systemd/system/ploydok.service" 0644
  fi
  render_template validator.toml | write_file "$DATA_DIR/config/validator.toml" 0640 ploydok:ploydok
  render_template buildkitd.toml | write_file "$DATA_DIR/config/buildkitd.toml" 0644 ploydok:ploydok
  render_template prometheus.yml | write_file "$DATA_DIR/config/prometheus.yml" 0644 ploydok:ploydok
  render_template ploydok-alerts.yml | write_file "$DATA_DIR/config/ploydok-alerts.yml" 0644 ploydok:ploydok
  render_alertmanager | write_file "$DATA_DIR/config/alertmanager.yml" 0644 ploydok:ploydok
  render_template ploydok.target | write_file "/etc/systemd/system/ploydok.target" 0644
  if [[ "$MODE" == "coexist" ]]; then
    render_template nginx-ploydok.conf | write_file "/etc/nginx/snippets/ploydok.conf" 0644
    render_template apache-ploydok.conf | write_file "/etc/apache2/conf-available/ploydok.conf" 0644
  fi
}

configure_firewall() {
  [[ "$MANAGE_FIREWALL" == "1" ]] || return 0
  if command -v ufw >/dev/null 2>&1; then
    run ufw allow 22/tcp
    if [[ "$MODE" == "coexist" ]]; then
      warn "coexist mode keeps Ploydok bound to loopback; not opening $HTTP_PORT/$HTTPS_PORT publicly"
    elif [[ "$MODE" == "bootstrap-http" ]]; then
      run ufw allow "${HTTP_PORT}/tcp"
      warn "bootstrap-http exposes HTTP on $HTTP_PORT; keep the VPS security group IP-restricted"
    else
      run ufw allow 80/tcp
      run ufw allow 443/tcp
    fi
    run ufw deny 2019 || true
    run ufw deny 5000 || true
  elif command -v firewall-cmd >/dev/null 2>&1; then
    if [[ "$MODE" == "coexist" ]]; then
      warn "coexist mode keeps Ploydok bound to loopback; not opening $HTTP_PORT/$HTTPS_PORT publicly"
    elif [[ "$MODE" == "bootstrap-http" ]]; then
      run firewall-cmd --permanent --add-port="${HTTP_PORT}/tcp"
    else
      run firewall-cmd --permanent --add-service=http
      run firewall-cmd --permanent --add-service=https
    fi
    run firewall-cmd --reload
  else
    warn "no supported firewall manager detected; wrote docs only"
  fi
}

start_services() {
  run systemctl daemon-reload
  if [[ "$RUNTIME" == "swarm" ]]; then
    run systemctl enable ploydok.target ploydok-port-isolation.service ploydok.service
    # Restarting a required unit would stop ploydok.service too.
    run systemctl reload-or-restart ploydok-port-isolation.service
  else
    run systemctl enable ploydok.target ploydok.service
  fi
  if [[ "$RUNTIME" == "swarm" ]]; then
    # Active oneshot units redeploy through ExecReload; inactive units start.
    run systemctl reload-or-restart ploydok.service
  else
    run systemctl restart ploydok.service
  fi
  if [[ "$RUNTIME" == "swarm" ]]; then
    run docker service update --force ploydok_prometheus
    run docker service update --force ploydok_alertmanager
  else
    run docker compose --env-file "$DATA_DIR/.env" -f "$INSTALL_DIR/docker-compose.yml" \
      up -d --no-deps --force-recreate prometheus alertmanager
  fi
  if [[ "$RUNTIME" == "swarm" ]]; then
    if [[ "${PLOYDOK_ENABLE_AUTO_UPDATES:-0}" != "1" ]]; then
      log "automatic Swarm updates disabled by default; use ploydok-cli upgrade with a pinned version"
      if [[ "$DRY_RUN" == "1" ]]; then
        log "dry-run: systemctl disable --now ploydok-update.timer"
      else
        systemctl disable --now ploydok-update.timer >/dev/null 2>&1 || true
      fi
    elif [[ "${PLOYDOK_ALLOW_EDGE:-0}" != "1" ]]; then
      die "automatic updates are only available for the explicit development edge channel" 2
    elif [[ "${PLOYDOK_INSTALL_SKIP_COSIGN:-0}" == "1" ]]; then
      warn "automatic Swarm updates disabled because signature verification was explicitly skipped"
      if [[ "$DRY_RUN" == "1" ]]; then
        log "dry-run: systemctl disable --now ploydok-update.timer"
      else
        systemctl disable --now ploydok-update.timer >/dev/null 2>&1 || true
      fi
    else
      run systemctl enable --now ploydok-update.timer
    fi
  fi
}

wait_health() {
  [[ "$DRY_RUN" == "1" ]] && return
  if [[ "$RUNTIME" == "swarm" ]]; then
    wait_health_swarm
    return
  fi
  local url="http://127.0.0.1:3335/health/ready"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "healthcheck OK"
      wait_monitoring_compose
      return
    fi
    sleep 1
  done
  die "healthcheck timed out: $url" 1
}

wait_monitoring_compose() {
  local compose=(docker compose --env-file "$DATA_DIR/.env" -f "$INSTALL_DIR/docker-compose.yml")
  local service port
  for service in prometheus alertmanager; do
    port=9090
    [[ "$service" == "alertmanager" ]] && port=9093
    for _ in $(seq 1 60); do
      if "${compose[@]}" exec -T "$service" wget -qO- "http://127.0.0.1:${port}/-/ready" >/dev/null 2>&1; then
        log "$service readiness OK"
        break
      fi
      sleep 1
    done
    "${compose[@]}" exec -T "$service" wget -qO- "http://127.0.0.1:${port}/-/ready" >/dev/null 2>&1 ||
      die "$service readiness timed out" 1
  done
  for _ in $(seq 1 60); do
    if "${compose[@]}" exec -T prometheus wget -qO- \
      'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22ploydok-api%22%7D%20%3D%3D%201' |
        grep -Fq '"result":[{' &&
      "${compose[@]}" exec -T prometheus wget -qO- \
        'http://127.0.0.1:9090/api/v1/alertmanagers' |
        grep -Fq '"activeAlertmanagers":[{'; then
      log "Prometheus authenticated scrape and Alertmanager discovery OK"
      return
    fi
    sleep 1
  done
  die "Prometheus pipeline validation timed out" 1
}

wait_swarm_service_healthy() {
  local service="$1" desired running healthy ids id status
  desired="$(docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' "ploydok_${service}" 2>/dev/null || echo 0)"
  for _ in $(seq 1 90); do
    ids="$(docker ps -q --filter "label=com.docker.swarm.service.name=ploydok_${service}")"
    running="$(grep -c . <<<"$ids" || true)"
    healthy=0
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [[ "$status" == "healthy" ]] && healthy=$((healthy + 1))
    done <<<"$ids"
    if [[ "$desired" -gt 0 && "$running" -ge "$desired" && "$healthy" -ge "$desired" ]]; then
      log "Swarm $service readiness OK ($healthy/$desired tasks)"
      return
    fi
    sleep 1
  done
  docker service ps --no-trunc "ploydok_${service}" >&2 || true
  die "Swarm $service readiness timed out" 1
}

wait_health_swarm() {
  local desired running healthy ids id status
  desired="$(docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' ploydok_api 2>/dev/null || echo 0)"
  for _ in $(seq 1 90); do
    ids="$(docker ps -q --filter label=com.docker.swarm.service.name=ploydok_api)"
    running="$(grep -c . <<<"$ids" || true)"
    healthy=0
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [[ "$status" == "healthy" || "$status" == "running" ]] && healthy=$((healthy + 1))
    done <<<"$ids"
    if [[ "$desired" -gt 0 && "$running" -ge "$desired" && "$healthy" -ge "$desired" ]]; then
      log "Swarm API readiness OK ($healthy/$desired tasks)"
      wait_swarm_service_healthy prometheus
      wait_swarm_service_healthy alertmanager
      wait_monitoring_pipeline_swarm
      return
    fi
    sleep 1
  done
  docker service ps --no-trunc ploydok_api >&2 || true
  die "Swarm API readiness timed out" 1
}

wait_monitoring_pipeline_swarm() {
  local id
  id="$(docker ps -q --filter label=com.docker.swarm.service.name=ploydok_prometheus | head -n1)"
  [[ -n "$id" ]] || die "Prometheus task missing during pipeline validation" 1
  for _ in $(seq 1 60); do
    if docker exec "$id" wget -qO- \
      'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22ploydok-api%22%7D%20%3D%3D%201' |
        grep -Fq '"result":[{' &&
      docker exec "$id" wget -qO- \
        'http://127.0.0.1:9090/api/v1/alertmanagers' |
        grep -Fq '"activeAlertmanagers":[{'; then
      log "Prometheus authenticated scrape and Alertmanager discovery OK"
      return
    fi
    sleep 1
  done
  die "Prometheus pipeline validation timed out" 1
}

test_alert_receiver() {
  [[ -n "$ALERT_WEBHOOK_URL" ]] || return 0
  local payload api_payload alertmanager_id prometheus_id compose
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: send explicit test notification to the configured alert receiver"
    return
  fi
  log "sending explicit test notification to the configured alert receiver"
  payload='{"version":"4","groupKey":"ploydok-installer-test","status":"firing","receiver":"operator-webhook","groupLabels":{"alertname":"PloydokInstallerTest"},"commonLabels":{"alertname":"PloydokInstallerTest","severity":"info"},"commonAnnotations":{"summary":"Ploydok alert receiver installation test"},"externalURL":"","alerts":[{"status":"firing","labels":{"alertname":"PloydokInstallerTest","severity":"info"},"annotations":{"summary":"Ploydok alert receiver installation test"},"startsAt":"1970-01-01T00:00:00Z","endsAt":"1970-01-01T00:00:00Z","generatorURL":"","fingerprint":"installer-test"}]}'
  api_payload='[{"labels":{"alertname":"PloydokInstallerPipelineTest","severity":"info"},"annotations":{"summary":"Ploydok Alertmanager pipeline test"},"startsAt":"2026-01-01T00:00:00Z"}]'
  if [[ "$RUNTIME" == "swarm" ]]; then
    alertmanager_id="$(docker ps -q --filter label=com.docker.swarm.service.name=ploydok_alertmanager | head -n1)"
    prometheus_id="$(docker ps -q --filter label=com.docker.swarm.service.name=ploydok_prometheus | head -n1)"
    [[ -n "$alertmanager_id" ]] || die "Alertmanager task missing during receiver test" 1
    [[ -n "$prometheus_id" ]] || die "Prometheus task missing during Alertmanager pipeline test" 1
    docker exec "$prometheus_id" wget -qO- --header="Content-Type: application/json" \
      --post-data="$api_payload" http://alertmanager:9093/api/v2/alerts >/dev/null ||
      die "Alertmanager pipeline test alert was rejected" 1
    docker exec "$alertmanager_id" sh -ec \
      'receiver="$(cat /run/ploydok-secrets/alert-webhook-url)"; wget -qO- --header="Content-Type: application/json" --post-data="$1" "$receiver"' \
      sh "$payload" >/dev/null || die "alert receiver test notification failed from Alertmanager network" 1
  else
    compose=(docker compose --env-file "$DATA_DIR/.env" -f "$INSTALL_DIR/docker-compose.yml")
    "${compose[@]}" exec -T prometheus wget -qO- --header="Content-Type: application/json" \
      --post-data="$api_payload" http://alertmanager:9093/api/v2/alerts >/dev/null ||
      die "Alertmanager pipeline test alert was rejected" 1
    "${compose[@]}" exec -T alertmanager sh -ec \
      'receiver="$(cat /run/ploydok-secrets/alert-webhook-url)"; wget -qO- --header="Content-Type: application/json" --post-data="$1" "$receiver"' \
      sh "$payload" >/dev/null || die "alert receiver test notification failed from Alertmanager network" 1
  fi
  log "alert receiver test notification accepted"
}

db_migrate() {
  [[ "$DRY_RUN" == "1" ]] && { log "dry-run: applying db migrations"; return; }
  if [[ "$RUNTIME" == "swarm" ]]; then
    db_migrate_swarm
  else
    db_migrate_compose
  fi
}

db_migrate_compose() {
  local compose=(docker compose --env-file "$DATA_DIR/.env" -f "$INSTALL_DIR/docker-compose.yml")
  log "waiting for postgres to accept connections"
  for _ in $(seq 1 60); do
    if "${compose[@]}" exec -T postgres pg_isready -U ploydok -d ploydok >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  log "applying database migrations"
  "${compose[@]}" exec -T api bun run /app/packages/db/src/migrate.ts
  log "restarting api after migrations"
  "${compose[@]}" restart api >/dev/null
}

db_migrate_swarm() {
  log "waiting for postgres task to be ready"
  local pg_id=""
  for _ in $(seq 1 60); do
    pg_id="$(docker ps -q --filter label=com.docker.swarm.service.name=ploydok_postgres | head -n1)"
    if [[ -n "$pg_id" ]] && docker exec "$pg_id" pg_isready -U ploydok -d ploydok >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  [[ -n "$pg_id" ]] || die "postgres task did not appear in time" 1
  log "applying database migrations"
  local api_id
  api_id="$(docker ps -q --filter label=com.docker.swarm.service.name=ploydok_api | head -n1)"
  [[ -n "$api_id" ]] || die "api task did not appear in time" 1
  docker exec "$api_id" bun run /app/packages/db/src/migrate.ts
  log "forcing api rolling restart after migrations"
  run docker service update --force --detach ploydok_api
}

main() {
  require_root
  preflight
  choose_mode
  load_existing_alerting
  validate_alerting
  validate_release_channel
  configure_binds
  resolve_public_endpoint
  log "installing Ploydok $VERSION in mode=$MODE install_dir=$INSTALL_DIR data_dir=$DATA_DIR origin=$PUBLIC_ORIGIN"
  takeover_proxy
  create_system_user
  create_directories
  generate_secrets
  generate_mtls
  generate_agent_pki
  prepare_runtime_transition
  ensure_swarm
  verify_or_pull_images
  write_templates
  configure_firewall
  install_cli
  start_services
  wait_health
  db_migrate
  wait_health
  test_alert_receiver
  if [[ "$SETUP_TOKEN_REQUIRED" == "1" ]]; then
    log "Ploydok installed. First admin is locked: open the URL printed in the API logs, or set PLOYDOK_SETUP_TOKEN."
  else
    log "Ploydok installed. Open ${PUBLIC_ORIGIN}/setup and create the first admin. The first person to submit the form owns the instance."
  fi
}

main "$@"
