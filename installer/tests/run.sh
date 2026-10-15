#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export PLOYDOK_ALERT_WEBHOOK_URL="https://alerts.example.test/ploydok"

assert_file() {
  [[ -f "$1" ]] || { echo "missing file: $1" >&2; exit 1; }
}

assert_contains() {
  local file="$1" needle="$2"
  grep -Fq -- "$needle" "$file" || { echo "expected $file to contain $needle" >&2; exit 1; }
}

assert_text_contains() {
  local text="$1" needle="$2"
  grep -Fq -- "$needle" <<<"$text" || { echo "expected text to contain $needle" >&2; exit 1; }
}

assert_text_not_contains() {
  local text="$1" needle="$2"
  ! grep -Fq -- "$needle" <<<"$text" || { echo "expected text not to contain $needle" >&2; exit 1; }
}

assert_not_exists() {
  [[ ! -e "$1" ]] || { echo "expected $1 to be absent" >&2; exit 1; }
}

PLOYDOK_INSTALL_DRY_RUN=1 \
PLOYDOK_INSTALL_ROOT="$TMP/root" \
PLOYDOK_PUBLIC_HOST="ploydok.test" \
bash "$ROOT/installer/install.sh" \
  --mode=coexist \
  --runtime=compose \
  --http-port=18080 \
  --https-port=18443 \
  --data-dir=/var/lib/ploydok \
  --skip-docker-install \
  --yes \
  --version=test

assert_file "$TMP/root/opt/ploydok/docker-compose.yml"
assert_file "$TMP/root/opt/ploydok/Caddyfile"
assert_file "$TMP/root/var/lib/ploydok/.env"
assert_file "$TMP/root/var/lib/ploydok/config/buildkitd.toml"
assert_file "$TMP/root/var/lib/ploydok/config/prometheus.yml"
assert_file "$TMP/root/var/lib/ploydok/config/ploydok-alerts.yml"
assert_file "$TMP/root/var/lib/ploydok/config/alertmanager.yml"
assert_file "$TMP/root/var/lib/ploydok/secrets/metrics-token"
assert_file "$TMP/root/var/lib/ploydok/secrets/alert-webhook-url"
assert_file "$TMP/root/etc/nginx/snippets/ploydok.conf"
assert_file "$TMP/root/etc/apache2/conf-available/ploydok.conf"
assert_file "$TMP/root/etc/systemd/system/ploydok.service"
assert_file "$TMP/root/usr/local/bin/ploydok-cli"
assert_file "$TMP/root/usr/local/lib/ploydok/ploydok-dr"
assert_file "$TMP/root/usr/local/lib/ploydok/verify-restored-platform"
assert_not_exists "$TMP/root/var/lib/ploydok/docker-compose.yml"
assert_not_exists "$TMP/root/var/lib/ploydok/postgres"
assert_not_exists "$TMP/root/var/lib/ploydok/redis"
assert_not_exists "$TMP/root/var/lib/ploydok/registry"
assert_not_exists "$TMP/root/var/lib/ploydok/caddy"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "127.0.0.1:18080:80"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "ploydok-web:test"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "PLOYDOK_AGENT_ADDR: 0.0.0.0:50051"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "postgres-data:/var/lib/postgresql/data"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "redis-data:/data"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "registry-data:/var/lib/registry"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "moby/buildkit:v0.29.0-rootless"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "buildkit-cache:/home/user/.local/share/buildkit"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "/var/run/docker.sock:/var/run/docker.sock"
compose_api_block="$(sed -n '/^  api:/,/^  web:/p' "$TMP/root/opt/ploydok/docker-compose.yml")"
compose_agent_block="$(sed -n '/^  agent:/,/^  caddy:/p' "$TMP/root/opt/ploydok/docker-compose.yml")"
assert_text_not_contains "$compose_api_block" "/var/run/docker.sock"
assert_text_contains "$compose_agent_block" "/var/run/docker.sock"
assert_text_contains "$compose_api_block" 'user: "${PLOYDOK_RUNTIME_UID}:${PLOYDOK_RUNTIME_GID}"'
assert_text_contains "$compose_api_block" "read_only: true"
assert_text_contains "$compose_api_block" 'cap_drop: ["ALL"]'
assert_text_contains "$compose_api_block" "no-new-privileges:true"
assert_text_not_contains "$compose_api_block" "/certs:/var/lib/ploydok/certs"
assert_text_not_contains "$compose_api_block" "/pki:/var/lib/ploydok/pki"
assert_text_not_contains "$compose_api_block" "/server.key:"
assert_text_not_contains "$compose_api_block" "/ca.key:"
assert_text_contains "$compose_agent_block" "/pki/server.key:/var/lib/ploydok/pki/server.key:ro"
assert_text_not_contains "$compose_agent_block" "/client.key:"
assert_text_not_contains "$compose_agent_block" "/ca.key:"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "ploydok.kind: infra"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "ploydok.component: caddy"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "caddy-data:/data"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "caddy-config:/config"
assert_contains "$TMP/root/opt/ploydok/Caddyfile" "https://ploydok.test"
assert_contains "$TMP/root/opt/ploydok/Caddyfile" "host localhost ploydok.local ploydok.test"
assert_contains "$TMP/root/opt/ploydok/Caddyfile" "route @control_plane"
assert_contains "$TMP/root/opt/ploydok/Caddyfile" "reverse_proxy web:3000"
assert_contains "$TMP/root/opt/ploydok/Caddyfile" "handle_path /api/*"
assert_contains "$TMP/root/var/lib/ploydok/.env" "WEB_ORIGIN=https://ploydok.test"
assert_contains "$TMP/root/var/lib/ploydok/.env" "GITHUB_APP_CALLBACK_URL=https://ploydok.test/github/app/callback"
assert_contains "$TMP/root/var/lib/ploydok/.env" "GITLAB_OAUTH_CALLBACK_URL=https://ploydok.test/gitlab/callback"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_DOMAIN_BASE=apps.ploydok.test"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_SETUP_TOKEN_REQUIRED=0"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_COOKIE_SECURE=auto"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_TRUST_PROXY_HEADERS=true"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_REGISTRY_URL=127.0.0.1:5000"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_REGISTRY_API_URL=registry:5000"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_BUILDKIT_ADDR=tcp://buildkitd:1234"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_AGENT_ADDR=agent:50051"
assert_contains "$TMP/root/var/lib/ploydok/config/buildkitd.toml" '[registry."registry:5000"]'
assert_contains "$TMP/root/var/lib/ploydok/config/validator.toml" 'allowed_registries = ['
assert_contains "$TMP/root/var/lib/ploydok/config/validator.toml" '"registry:5000"'
assert_contains "$TMP/root/var/lib/ploydok/config/validator.toml" 'volume_prefix = "/var/lib/ploydok/volumes"'
assert_contains "$TMP/root/var/lib/ploydok/config/validator.toml" 'app_volume_prefix = "/var/lib/ploydok/app-volumes"'
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_AGENT_CLIENT_CERT=/var/lib/ploydok/pki/client.pem"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_RUNTIME_UID=1000"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_RUNTIME_GID=1000"
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_METRICS_TOKEN="
assert_contains "$TMP/root/var/lib/ploydok/config/prometheus.yml" "credentials_file: /run/ploydok-secrets/metrics-token"
assert_contains "$TMP/root/var/lib/ploydok/config/prometheus.yml" "# ploydok-monitoring-schema: 1"
assert_contains "$TMP/root/var/lib/ploydok/config/ploydok-alerts.yml" "# ploydok-monitoring-schema: 1"
assert_contains "$TMP/root/var/lib/ploydok/config/alertmanager.yml" "# ploydok-monitoring-schema: 1"
assert_contains "$TMP/root/var/lib/ploydok/config/ploydok-alerts.yml" "alert: ControlPlaneNotReady"
assert_contains "$TMP/root/var/lib/ploydok/config/ploydok-alerts.yml" "runbook_url: https://github.com/dev-toolings/ploydok/blob/main/OPERATIONS.md"
assert_contains "$TMP/root/var/lib/ploydok/config/alertmanager.yml" "url_file: /run/ploydok-secrets/alert-webhook-url"
assert_contains "$TMP/root/var/lib/ploydok/secrets/alert-webhook-url" "https://alerts.example.test/ploydok"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "prom/prometheus:v3.13.1@sha256:"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" "prom/alertmanager:v0.33.1@sha256:"
assert_contains "$TMP/root/etc/nginx/snippets/ploydok.conf" "proxy_pass http://127.0.0.1:18080;"
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" 'POSTGRES_PASSWORD: ${PLOYDOK_PG_PASSWORD}'
assert_contains "$TMP/root/opt/ploydok/docker-compose.yml" '"${PLOYDOK_REDIS_PASSWORD}"'

master_key_before="$(cat "$TMP/root/var/lib/ploydok/master.key")"
env_before="$(cat "$TMP/root/var/lib/ploydok/.env")"
touch -d '2026-08-18T12:00:00Z' "$TMP/root/var/lib/ploydok/backups/control-plane.configured"
chmod u+w "$TMP/root/var/lib/ploydok/backups/control-plane.last-success"
printf '%s\n' '2026-08-18T12:05:00Z' >"$TMP/root/var/lib/ploydok/backups/control-plane.last-success"
chmod 0444 "$TMP/root/var/lib/ploydok/backups/control-plane.last-success"
configured_mtime_before="$(stat -c %Y "$TMP/root/var/lib/ploydok/backups/control-plane.configured")"
success_stamp_before="$(cat "$TMP/root/var/lib/ploydok/backups/control-plane.last-success")"

env -u PLOYDOK_ALERT_WEBHOOK_URL \
  PLOYDOK_INSTALL_DRY_RUN=1 \
  PLOYDOK_INSTALL_ROOT="$TMP/root" \
  PLOYDOK_PUBLIC_HOST="ploydok.test" \
  bash "$ROOT/installer/install.sh" \
  --mode=coexist \
  --runtime=compose \
  --http-port=18080 \
  --https-port=18443 \
  --data-dir=/var/lib/ploydok \
  --skip-docker-install \
  --yes \
  --version=test

[[ "$(cat "$TMP/root/var/lib/ploydok/master.key")" == "$master_key_before" ]] || {
  echo "master key changed on idempotent install" >&2
  exit 1
}
[[ "$(cat "$TMP/root/var/lib/ploydok/.env")" == "$env_before" ]] || {
  echo ".env changed on idempotent install" >&2
  exit 1
}
assert_contains "$TMP/root/var/lib/ploydok/secrets/alert-webhook-url" "https://alerts.example.test/ploydok"
[[ "$(stat -c %Y "$TMP/root/var/lib/ploydok/backups/control-plane.configured")" == "$configured_mtime_before" ]] || {
  echo "control-plane configured stamp changed on idempotent install" >&2
  exit 1
}
[[ "$(cat "$TMP/root/var/lib/ploydok/backups/control-plane.last-success")" == "$success_stamp_before" ]] || {
  echo "control-plane success stamp changed on idempotent install" >&2
  exit 1
}

upgrade_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/root" PLOYDOK_INSTALL_SKIP_COSIGN=1 \
    bash "$ROOT/installer/ploydok-cli" upgrade --data-dir=/var/lib/ploydok --version=test2 2>&1
)"
assert_text_contains "$upgrade_output" "update $TMP/root/opt/ploydok/docker-compose.yml api/web/agent/adminer images to test2"
assert_text_contains "$upgrade_output" "docker pull ghcr.io/dev-toolings/ploydok-api:test2"
assert_text_contains "$upgrade_output" "docker pull ghcr.io/dev-toolings/ploydok-web:test2"
assert_text_contains "$upgrade_output" "docker pull ghcr.io/dev-toolings/ploydok-agent:test2"
assert_text_contains "$upgrade_output" "docker pull ghcr.io/dev-toolings/ploydok-adminer:test2"
assert_text_contains "$upgrade_output" "up -d --no-deps api web agent adminer"
assert_text_contains "$upgrade_output" "run --rm --no-deps api bun run /app/packages/db/src/migrate.ts"
assert_text_contains "$upgrade_output" "chmod 0400"
assert_text_contains "$upgrade_output" "chown 65534:65534"
assert_text_contains "$upgrade_output" "--force-recreate prometheus alertmanager"
assert_text_contains "$upgrade_output" "send explicit test notification"
assert_text_not_contains "$upgrade_output" "ploydok-caddy:test2"

pki_rotation_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/root" \
    bash "$ROOT/installer/ploydok-cli" rotate-agent-pki --data-dir=/var/lib/ploydok --yes
)"
assert_text_contains "$pki_rotation_output" "force-recreate agent then API"

release_digest="sha256:$(printf 'a%.0s' {1..64})"
release_manifest="$TMP/root/var/lib/ploydok/release-images.env"
cat >"$release_manifest" <<EOF
PLOYDOK_API_IMAGE=ghcr.io/dev-toolings/ploydok-api@$release_digest
PLOYDOK_WEB_IMAGE=ghcr.io/dev-toolings/ploydok-web@$release_digest
PLOYDOK_AGENT_IMAGE=ghcr.io/dev-toolings/ploydok-agent@$release_digest
PLOYDOK_ADMINER_IMAGE=ghcr.io/dev-toolings/ploydok-adminer@$release_digest
PLOYDOK_CADDY_IMAGE=ghcr.io/dev-toolings/ploydok-caddy@$release_digest
EOF
release_upgrade_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/root" PLOYDOK_INSTALL_SKIP_COSIGN=1 \
    bash "$ROOT/installer/ploydok-cli" upgrade --data-dir=/var/lib/ploydok \
      --version=candidate-test --image-manifest=/var/lib/ploydok/release-images.env \
      --include-data-plane 2>&1
)"
assert_text_contains "$release_upgrade_output" "docker pull ghcr.io/dev-toolings/ploydok-api@$release_digest"
assert_text_contains "$release_upgrade_output" "docker pull ghcr.io/dev-toolings/ploydok-caddy@$release_digest"

printf '%s\n' 'PLOYDOK_API_IMAGE=ghcr.io/dev-toolings/ploydok-api:mutable' >"$release_manifest"
if PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/root" PLOYDOK_INSTALL_SKIP_COSIGN=1 \
  bash "$ROOT/installer/ploydok-cli" upgrade --data-dir=/var/lib/ploydok \
    --version=invalid --image-manifest=/var/lib/ploydok/release-images.env >/dev/null 2>&1; then
  echo "mutable release image manifest was accepted" >&2
  exit 1
fi

upgrade_data_plane_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/root" PLOYDOK_INSTALL_SKIP_COSIGN=1 \
    bash "$ROOT/installer/ploydok-cli" upgrade --data-dir=/var/lib/ploydok --version=test3 --include-data-plane 2>&1
)"
assert_text_contains "$upgrade_data_plane_output" "ploydok-caddy:test3"
assert_text_contains "$upgrade_data_plane_output" "update $TMP/root/opt/ploydok/docker-compose.yml api/web/agent/adminer/caddy images to test3"
assert_text_contains "$upgrade_data_plane_output" "docker pull ghcr.io/dev-toolings/ploydok-caddy:test3"
assert_text_contains "$upgrade_data_plane_output" "up -d --no-deps api web agent adminer caddy"

backup_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
    bash "$ROOT/installer/ploydok-cli" backup-control-plane \
      --destination=/mnt/off-host/ploydok \
      --age-recipient=age1testrecipient \
      --signing-key=/run/secrets/ploydok-backup-signing-key \
      --retention-days=30 2>&1
)"
assert_text_contains "$backup_output" "create encrypted, checksummed backup"
assert_text_contains "$backup_output" "retain backups for 30 days"

backup_timer_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
    bash "$ROOT/installer/ploydok-cli" configure-control-plane-backups \
      --destination=/mnt/off-host/ploydok \
      --age-recipient=age1testrecipient \
      --signing-key=/run/secrets/ploydok-backup-signing-key \
      --retention-days=30 2>&1
)"
assert_text_contains "$backup_timer_output" "install a persistent daily backup timer"

restore_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
    bash "$ROOT/installer/ploydok-cli" restore-control-plane \
      --archive=/mnt/off-host/ploydok/ploydok-control-plane-test.tar.gz.age \
      --age-identity=/run/secrets/ploydok-backup-identity \
      --signing-public-key=/run/secrets/ploydok-backup-signing-public-key \
      --verify-command=/usr/local/lib/ploydok/verify-restored-platform \
      --yes 2>&1
)"
assert_text_contains "$restore_output" "restore Postgres, Redis, registry, Caddy, monitoring, app volumes, keys, certificates and config"
assert_text_contains "$restore_output" "require readiness then run /usr/local/lib/ploydok/verify-restored-platform"

PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/root" \
bash "$ROOT/installer/ploydok-cli" uninstall --data-dir=/var/lib/ploydok --yes --restore-previous-proxy

PLOYDOK_INSTALL_DRY_RUN=1 \
PLOYDOK_INSTALL_ROOT="$TMP/takeover-root" \
bash "$ROOT/installer/install.sh" \
  --mode=takeover \
  --runtime=compose \
  --data-dir=/var/lib/ploydok \
  --skip-docker-install \
  --yes \
  --version=test

assert_contains "$TMP/takeover-root/opt/ploydok/docker-compose.yml" '"80:80"'
assert_contains "$TMP/takeover-root/opt/ploydok/docker-compose.yml" '"443:443"'

# Unattended defaults never override an explicit mode, in either argument order.
for scenario in mode-first unattended-first unattended-only; do
  case "$scenario" in
    mode-first) mode_args=(--mode=takeover --unattended); expected_mode=takeover ;;
    unattended-first) mode_args=(--unattended --mode=takeover); expected_mode=takeover ;;
    unattended-only) mode_args=(--unattended); expected_mode=coexist ;;
  esac
  unattended_output="$(
    PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/$scenario-root" \
      bash "$ROOT/installer/install.sh" "${mode_args[@]}" \
        --public-host=ploydok.test --skip-docker-install --version=test 2>&1
  )"
  assert_text_contains "$unattended_output" "installing Ploydok test in mode=$expected_mode"
  if [[ "$expected_mode" == takeover ]]; then
    assert_contains "$TMP/$scenario-root/opt/ploydok/docker-stack.yml" "published: 80"
    assert_contains "$TMP/$scenario-root/opt/ploydok/docker-stack.yml" "published: 443"
  else
    assert_contains "$TMP/$scenario-root/opt/ploydok/docker-stack.yml" "published: 8080"
    assert_contains "$TMP/$scenario-root/opt/ploydok/docker-stack.yml" "published: 8443"
  fi
done

PLOYDOK_INSTALL_DRY_RUN=1 \
PLOYDOK_INSTALL_ROOT="$TMP/bootstrap-root" \
bash "$ROOT/installer/install.sh" \
  --mode=bootstrap-http \
  --runtime=compose \
  --http-port=18080 \
  --https-port=18443 \
  --public-host=212.47.249.36 \
  --data-dir=/var/lib/ploydok \
  --skip-docker-install \
  --yes \
  --version=test

assert_contains "$TMP/bootstrap-root/opt/ploydok/docker-compose.yml" '"0.0.0.0:18080:80"'
assert_contains "$TMP/bootstrap-root/opt/ploydok/docker-compose.yml" '"127.0.0.1:18443:443"'
assert_contains "$TMP/bootstrap-root/opt/ploydok/Caddyfile" "http://212.47.249.36"
assert_contains "$TMP/bootstrap-root/var/lib/ploydok/.env" "WEB_ORIGIN=http://212.47.249.36:18080"
assert_contains "$TMP/bootstrap-root/var/lib/ploydok/.env" "PLOYDOK_PUBLIC_SCHEME=http"
assert_contains "$TMP/bootstrap-root/var/lib/ploydok/.env" "PLOYDOK_PUBLIC_PORT=18080"
assert_contains "$TMP/bootstrap-root/var/lib/ploydok/.env" "PLOYDOK_DOMAIN_BASE=212-47-249-36.sslip.io"
assert_contains "$TMP/bootstrap-root/var/lib/ploydok/.env" "PLOYDOK_SETUP_TOKEN_REQUIRED=0"
assert_contains "$TMP/bootstrap-root/var/lib/ploydok/.env" "PLOYDOK_COOKIE_SECURE=auto"
assert_contains "$TMP/bootstrap-root/var/lib/ploydok/.env" "PLOYDOK_TRUST_PROXY_HEADERS=true"

PLOYDOK_INSTALL_DRY_RUN=1 \
PLOYDOK_INSTALL_ROOT="$TMP/swarm-root" \
PLOYDOK_PUBLIC_HOST="ploydok.test" \
bash "$ROOT/installer/install.sh" \
  --mode=takeover \
  --data-dir=/var/lib/ploydok \
  --skip-docker-install \
  --yes \
  --version=test

assert_file "$TMP/swarm-root/opt/ploydok/docker-stack.yml"
assert_file "$TMP/swarm-root/opt/ploydok/CaddyAdminProxyfile"
assert_file "$TMP/swarm-root/usr/local/lib/ploydok/port-isolation.sh"
assert_file "$TMP/swarm-root/usr/local/lib/ploydok/update-stack.sh"
assert_file "$TMP/swarm-root/etc/systemd/system/ploydok-port-isolation.service"
assert_not_exists "$TMP/swarm-root/opt/ploydok/docker-compose.yml"
assert_contains "$TMP/swarm-root/etc/systemd/system/ploydok.service" "docker stack deploy"
assert_contains "$TMP/swarm-root/etc/systemd/system/ploydok.service" "ExecReload=/usr/bin/docker stack deploy"
assert_contains "$TMP/swarm-root/etc/systemd/system/ploydok.service" "ExecStop=/usr/local/lib/ploydok/stop-stack.sh"
assert_contains "$TMP/swarm-root/etc/systemd/system/ploydok.service" "ExecStartPre=/usr/local/lib/ploydok/stop-stack.sh wait"
assert_contains "$TMP/swarm-root/etc/systemd/system/ploydok.service" "ExecReload=/usr/local/lib/ploydok/stop-stack.sh wait"
assert_contains "$TMP/swarm-root/etc/systemd/system/ploydok-port-isolation.service" "ExecReload=/usr/local/lib/ploydok/port-isolation.sh start"
assert_file "$TMP/swarm-root/usr/local/lib/ploydok/stop-stack.sh"
assert_contains "$TMP/swarm-root/opt/ploydok/docker-stack.yml" "published: 80"
assert_contains "$TMP/swarm-root/opt/ploydok/docker-stack.yml" "published: 443"
assert_contains "$TMP/swarm-root/opt/ploydok/docker-stack.yml" "/var/lib/ploydok/keys:/var/lib/ploydok/keys"
assert_contains "$TMP/swarm-root/opt/ploydok/docker-stack.yml" "moby/buildkit:v0.29.0"
assert_contains "$TMP/swarm-root/opt/ploydok/docker-stack.yml" "buildkit-cache:/var/lib/buildkit"
assert_text_not_contains "$(sed -n '/^  buildkitd:/,/^networks:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")" "buildkit-cache:/home/user/.local/share/buildkit"
assert_contains "$TMP/swarm-root/opt/ploydok/Caddyfile" "admin unix//run/caddy-admin/admin.sock|0660"
assert_text_not_contains "$(cat "$TMP/swarm-root/opt/ploydok/Caddyfile")" "admin 0.0.0.0:2019"
assert_contains "$TMP/swarm-root/opt/ploydok/CaddyAdminProxyfile" "reverse_proxy unix//run/caddy-admin/admin.sock"
assert_contains "$TMP/swarm-root/var/lib/ploydok/.env" "CADDY_ADMIN_URL=http://caddy-admin:2019"
assert_contains "$TMP/swarm-root/opt/ploydok/docker-stack.yml" "prom/prometheus:v3.13.1@sha256:"
assert_contains "$TMP/swarm-root/opt/ploydok/docker-stack.yml" "prom/alertmanager:v0.33.1@sha256:"
[[ "$(stat -c %a "$TMP/swarm-root/var/lib/ploydok/secrets/metrics-token")" == "400" ]] || { echo "metrics token must be mode 0400" >&2; exit 1; }
[[ "$(stat -c %a "$TMP/swarm-root/var/lib/ploydok/secrets/alert-webhook-url")" == "400" ]] || { echo "alert webhook secret must be mode 0400" >&2; exit 1; }
[[ "$(stat -c %a "$TMP/swarm-root/var/lib/ploydok/backups/control-plane.configured")" == "444" ]] || { echo "control-plane configured stamp must be readable by API" >&2; exit 1; }
[[ "$(stat -c %a "$TMP/swarm-root/var/lib/ploydok/backups/control-plane.last-success")" == "444" ]] || { echo "control-plane success stamp must be readable by API" >&2; exit 1; }
[[ "$(stat -c %a "$TMP/swarm-root/var/lib/ploydok/backups/control-plane.last-failure")" == "444" ]] || { echo "control-plane failure stamp must be readable by API" >&2; exit 1; }
api_block="$(sed -n '/^  api:/,/^  web:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
web_block="$(sed -n '/^  web:/,/^  postgres:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
agent_block="$(sed -n '/^  agent:/,/^  caddy:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
registry_block="$(sed -n '/^  registry:/,/^  buildkitd:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
buildkit_block="$(sed -n '/^  buildkitd:/,/^networks:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
caddy_block="$(sed -n '/^  caddy:$/,/^  caddy-admin:$/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
caddy_admin_block="$(sed -n '/^  caddy-admin:/,/^  adminer:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
management_block="$(sed -n '/^  ploydok-management:/,/^volumes:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
assert_text_contains "$api_block" "- ploydok-management"
assert_text_contains "$api_block" "- ploydok-build"
assert_text_contains "$api_block" "- ploydok-monitoring"
assert_text_contains "$registry_block" "- ploydok-build"
assert_text_contains "$buildkit_block" "- ploydok-build"
! grep -Fxq -- "      - ploydok" <<<"$buildkit_block" || { echo "buildkitd must not join the general ploydok network" >&2; exit 1; }
assert_text_not_contains "$web_block" "- ploydok-build"
assert_text_contains "$web_block" '"bun"'
assert_text_contains "$web_block" "fetch('http://127.0.0.1:3000/',{redirect:'manual'})"
assert_text_contains "$web_block" 'r.status>=200&&r.status<400'
assert_text_not_contains "$web_block" '"wget"'
assert_text_not_contains "$agent_block" "- ploydok-build"
assert_text_not_contains "$api_block" "/var/run/docker.sock"
assert_text_contains "$agent_block" "/var/run/docker.sock"
assert_text_contains "$api_block" 'user: "${PLOYDOK_RUNTIME_UID}:${PLOYDOK_RUNTIME_GID}"'
assert_text_contains "$api_block" "read_only: true"
assert_text_contains "$api_block" 'cap_drop: ["ALL"]'
assert_text_contains "$api_block" "no-new-privileges:true"
assert_text_not_contains "$api_block" "/certs:/var/lib/ploydok/certs"
assert_text_contains "$api_block" "backups/control-plane.last-success:/var/lib/ploydok/backups/control-plane.last-success:ro"
assert_text_contains "$api_block" "backups/control-plane.last-failure:/var/lib/ploydok/backups/control-plane.last-failure:ro"
assert_text_contains "$api_block" "backups/control-plane.configured:/var/lib/ploydok/backups/control-plane.configured:ro"
assert_text_not_contains "$api_block" "backups:/var/lib/ploydok/backups:ro"
assert_text_not_contains "$api_block" "/pki:/var/lib/ploydok/pki"
assert_text_not_contains "$api_block" "/server.key:"
assert_text_not_contains "$api_block" "/ca.key:"
assert_text_contains "$agent_block" "/pki/server.key:/var/lib/ploydok/pki/server.key:ro"
assert_text_not_contains "$agent_block" "/client.key:"
assert_text_not_contains "$agent_block" "/ca.key:"
assert_text_contains "$caddy_block" "- ploydok-public"
assert_text_not_contains "$caddy_block" "- ploydok-management"
assert_text_contains "$caddy_admin_block" "- ploydok-management"
assert_text_not_contains "$caddy_admin_block" "- ploydok-public"
assert_text_contains "$caddy_admin_block" "- caddy"
assert_text_contains "$caddy_admin_block" "- run"
assert_text_contains "$management_block" "internal: true"
assert_text_contains "$management_block" "attachable: false"
assert_contains "$TMP/swarm-root/opt/ploydok/docker-stack.yml" "ploydok-build:"
build_network_block="$(sed -n '/^  ploydok-build:/,/^volumes:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
assert_text_contains "$build_network_block" "internal: false"
assert_text_contains "$build_network_block" "attachable: false"
[[ "$(grep -Fc -- "- ploydok-build" "$TMP/swarm-root/opt/ploydok/docker-stack.yml")" -eq 3 ]] || { echo "ploydok-build must be attached only to api, registry and buildkitd" >&2; exit 1; }
monitoring_network_block="$(sed -n '/^  ploydok-monitoring:/,/^volumes:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
assert_text_contains "$monitoring_network_block" "internal: true"
assert_text_contains "$monitoring_network_block" "attachable: false"
[[ "$(grep -Fc -- "- ploydok-monitoring" "$TMP/swarm-root/opt/ploydok/docker-stack.yml")" -eq 3 ]] || { echo "ploydok-monitoring must be attached only to api, prometheus and alertmanager" >&2; exit 1; }
alerting_network_block="$(sed -n '/^  ploydok-alerting:/,/^volumes:/p' "$TMP/swarm-root/opt/ploydok/docker-stack.yml")"
assert_text_contains "$alerting_network_block" "internal: false"
assert_text_contains "$alerting_network_block" "attachable: false"
[[ "$(grep -Fc -- "- ploydok-alerting" "$TMP/swarm-root/opt/ploydok/docker-stack.yml")" -eq 1 ]] || { echo "ploydok-alerting must be attached only to alertmanager" >&2; exit 1; }
assert_text_not_contains "$(cat "$TMP/swarm-root/opt/ploydok/docker-stack.yml")" "host_ip:"
assert_contains "$TMP/swarm-root/usr/local/lib/ploydok/port-isolation.sh" 'MODE="takeover"'
assert_contains "$TMP/swarm-root/usr/local/lib/ploydok/port-isolation.sh" 'ports=(5000)'
assert_contains "$TMP/swarm-root/usr/local/lib/ploydok/port-isolation.sh" 'DOCKER-USER'
assert_contains "$TMP/swarm-root/usr/local/lib/ploydok/port-isolation.sh" 'apply_input_rules'
assert_contains "$TMP/swarm-root/usr/local/lib/ploydok/update-stack.sh" 'cosign verify'
assert_contains "$TMP/swarm-root/usr/local/lib/ploydok/update-stack.sh" 'PLOYDOK_ENABLE_AUTO_UPDATES'
assert_contains "$TMP/swarm-root/usr/local/lib/ploydok/update-stack.sh" 'IMAGE_PREFIX'
assert_contains "$TMP/swarm-root/usr/local/lib/ploydok/update-stack.sh" 'stop-stack.sh wait'
assert_contains "$TMP/swarm-root/etc/systemd/system/ploydok-update.service" '/usr/local/lib/ploydok/update-stack.sh'

swarm_upgrade_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/swarm-root" PLOYDOK_INSTALL_SKIP_COSIGN=1 \
    bash "$ROOT/installer/ploydok-cli" upgrade --data-dir=/var/lib/ploydok --version=test2 2>&1
)"
assert_text_contains "$swarm_upgrade_output" "update $TMP/swarm-root/opt/ploydok/docker-stack.yml api/web/agent/adminer images to test2"
assert_text_contains "$swarm_upgrade_output" "docker pull ghcr.io/dev-toolings/ploydok-api:test2"
assert_text_contains "$swarm_upgrade_output" "--network ploydok_ploydok ghcr.io/dev-toolings/ploydok-api:test2"
assert_text_contains "$swarm_upgrade_output" "bun run /app/packages/db/src/migrate.ts"
assert_text_contains "$swarm_upgrade_output" "docker stack deploy --resolve-image always"
assert_text_not_contains "$swarm_upgrade_output" "docker stack rm"
reinstall_output="$(PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/swarm-root" \
  PLOYDOK_PUBLIC_HOST=ploydok.test bash "$ROOT/installer/install.sh" \
  --mode=takeover --skip-docker-install --yes --version=test2 2>&1)"
assert_text_contains "$reinstall_output" "systemctl reload-or-restart ploydok-port-isolation.service"
assert_text_contains "$reinstall_output" "systemctl reload-or-restart ploydok.service"
assert_text_not_contains "$reinstall_output" "systemctl restart ploydok.service"
assert_text_not_contains "$reinstall_output" "systemctl stop ploydok.service"
assert_text_not_contains "$reinstall_output" "docker stack rm"


swarm_uninstall_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/swarm-root" \
    bash "$ROOT/installer/ploydok-cli" uninstall --data-dir=/var/lib/ploydok --yes 2>&1
)"
assert_text_contains "$swarm_uninstall_output" "systemctl disable --now ploydok.service"
assert_text_contains "$swarm_uninstall_output" "/usr/local/lib/ploydok/stop-stack.sh"
assert_text_contains "$swarm_uninstall_output" "systemctl disable --now ploydok-port-isolation.service"
assert_text_not_contains "$swarm_uninstall_output" "docker compose"

PLOYDOK_INSTALL_DRY_RUN=1 \
PLOYDOK_INSTALL_ROOT="$TMP/transition-root" \
PLOYDOK_PUBLIC_HOST="ploydok.test" \
bash "$ROOT/installer/install.sh" \
  --mode=coexist \
  --runtime=compose \
  --http-port=18080 \
  --https-port=18443 \
  --data-dir=/var/lib/ploydok \
  --skip-docker-install \
  --yes \
  --version=test >/dev/null

transition_output="$(
  PLOYDOK_INSTALL_DRY_RUN=1 \
  PLOYDOK_INSTALL_ROOT="$TMP/transition-root" \
  PLOYDOK_PUBLIC_HOST="ploydok.test" \
  bash "$ROOT/installer/install.sh" \
    --mode=coexist \
    --http-port=18080 \
    --https-port=18443 \
    --data-dir=/var/lib/ploydok \
    --skip-docker-install \
    --yes \
    --version=test 2>&1
)"
assert_text_contains "$transition_output" "migrating the control plane runtime from Compose to Swarm"
assert_text_contains "$transition_output" "docker compose --env-file"
assert_file "$TMP/transition-root/opt/ploydok/docker-stack.yml"

set +e
PLOYDOK_INSTALL_DRY_RUN=1 \
PLOYDOK_INSTALL_ROOT="$TMP/abort-root" \
bash "$ROOT/installer/install.sh" --mode=abort --skip-docker-install --yes >/dev/null 2>&1
abort_status=$?
set -e
[[ "$abort_status" -eq 2 ]] || { echo "abort mode returned $abort_status, expected 2" >&2; exit 1; }
assert_not_exists "$TMP/abort-root/opt/ploydok/docker-compose.yml"

for runtime in compose swarm; do
  no_alert_output="$(
    env -u PLOYDOK_ALERT_WEBHOOK_URL PLOYDOK_INSTALL_DRY_RUN=1 \
      PLOYDOK_INSTALL_ROOT="$TMP/no-alert-$runtime-root" \
      bash "$ROOT/installer/install.sh" --mode=coexist --runtime="$runtime" \
        --public-host=ploydok.test --skip-docker-install --yes --version=test 2>&1
  )"
  assert_text_contains "$no_alert_output" "WARN: alerting disabled"
  assert_text_contains "$no_alert_output" "--alert-webhook-url"
  assert_contains "$TMP/no-alert-$runtime-root/var/lib/ploydok/config/alertmanager.yml" "receiver: disabled"
  assert_text_not_contains "$(cat "$TMP/no-alert-$runtime-root/var/lib/ploydok/config/alertmanager.yml")" "url_file:"
  upgrade_no_alert_output="$(PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_INSTALL_ROOT="$TMP/no-alert-$runtime-root" \
    bash "$ROOT/installer/ploydok-cli" upgrade --version=test2 2>&1)"
  assert_text_contains "$upgrade_no_alert_output" "WARN: alerting disabled"
  PLOYDOK_ALERT_WEBHOOK_URL=https://alerts.example.test/enabled PLOYDOK_INSTALL_DRY_RUN=1 \
    PLOYDOK_INSTALL_ROOT="$TMP/no-alert-$runtime-root" \
    bash "$ROOT/installer/install.sh" --mode=coexist --runtime="$runtime" \
      --public-host=ploydok.test --skip-docker-install --yes --version=test >/dev/null 2>&1
  assert_contains "$TMP/no-alert-$runtime-root/var/lib/ploydok/config/alertmanager.yml" "url_file:"
  preserved_output="$(env -u PLOYDOK_ALERT_WEBHOOK_URL PLOYDOK_INSTALL_DRY_RUN=1 \
    PLOYDOK_INSTALL_ROOT="$TMP/no-alert-$runtime-root" \
    bash "$ROOT/installer/install.sh" --mode=coexist --runtime="$runtime" \
      --public-host=ploydok.test --skip-docker-install --yes --version=test 2>&1)"
  assert_text_not_contains "$preserved_output" "alerting disabled"
  assert_contains "$TMP/no-alert-$runtime-root/var/lib/ploydok/secrets/alert-webhook-url" "https://alerts.example.test/enabled"
done

for receiver in 'http://alerts.test' $'https://alerts.test\ninvalid'; do
  set +e
  invalid_alert_output="$(PLOYDOK_ALERT_WEBHOOK_URL="$receiver" PLOYDOK_INSTALL_DRY_RUN=1 \
    PLOYDOK_INSTALL_ROOT="$TMP/invalid-alert-root" \
    bash "$ROOT/installer/install.sh" --mode=coexist --runtime=compose \
      --public-host=ploydok.test --skip-docker-install --yes --version=test 2>&1)"
  invalid_alert_status=$?
  set -e
  [[ "$invalid_alert_status" -eq 2 ]] || { echo "invalid alert receiver accepted" >&2; exit 1; }
  assert_text_contains "$invalid_alert_output" "must be an HTTPS Alertmanager-compatible receiver"
  assert_not_exists "$TMP/invalid-alert-root/opt/ploydok/docker-compose.yml"
done

mkdir -p "$TMP/cosign-bin"
cat >"$TMP/cosign-bin/cosign" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod 0755 "$TMP/cosign-bin/cosign"
for identity in '' '^https://github\.com/example/fork/\.github/workflows/release-images\.yml@.*$'; do
  signature_output="$(PATH="$TMP/cosign-bin:$PATH" PLOYDOK_INSTALL_DRY_RUN=1 \
    PLOYDOK_INSTALL_ROOT="$TMP/root" PLOYDOK_COSIGN_IDENTITY_REGEXP="$identity" \
    bash "$ROOT/installer/ploydok-cli" upgrade --version=test-signature 2>&1)"
  expected_identity="${identity:-^https://github\.com/dev-toolings/ploydok/\.github/workflows/release-images\.yml@.*$}"
  assert_text_contains "$signature_output" "--certificate-identity-regexp $expected_identity"
done
assert_contains "$TMP/root/var/lib/ploydok/.env" "PLOYDOK_IMAGE_REGISTRY=ghcr.io/dev-toolings"
unsigned_output="$(PATH="$TMP/cosign-bin:$PATH" PLOYDOK_INSTALL_DRY_RUN=1 \
  PLOYDOK_INSTALL_SKIP_COSIGN=1 PLOYDOK_INSTALL_ROOT="$TMP/root" \
  bash "$ROOT/installer/ploydok-cli" upgrade --version=test-local 2>&1)"
assert_text_contains "$unsigned_output" "image signature verification explicitly skipped"
assert_text_not_contains "$unsigned_output" "--certificate-oidc-issuer"
assert_text_contains "$(bash "$ROOT/installer/install.sh" --help)" "PLOYDOK_COSIGN_IDENTITY_REGEXP"
assert_contains "$TMP/swarm-root/usr/local/lib/ploydok/update-stack.sh" 'PLOYDOK_COSIGN_IDENTITY_REGEXP:-$IDENTITY_REGEX'

bash "$ROOT/installer/tests/bootstrap.sh"
bash "$ROOT/installer/tests/disaster-recovery.sh"
bash "$ROOT/installer/tests/release-images.sh"
bash "$ROOT/installer/tests/stack-stop.sh"

echo "installer tests OK"
