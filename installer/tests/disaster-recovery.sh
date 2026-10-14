#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
cleanup_test() {
  if [[ "$(id -u)" -eq 0 ]]; then rm -rf -- "$TMP"; else sudo -n rm -rf -- "$TMP"; fi
}
trap cleanup_test EXIT
mkdir -p "$TMP/bin" "$TMP/payload"

cat >"$TMP/bin/age" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
output=""
archive=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --decrypt) shift ;;
    -i) shift 2 ;;
    -o) output="$2"; shift 2 ;;
    *) archive="$1"; shift ;;
  esac
done
cp -- "$archive" "$output"
EOF
chmod 0755 "$TMP/bin/age"

cat >"$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$PLOYDOK_DR_FAKE_DOCKER_LOG"
if [[ "$1" == "volume" && "$2" == "inspect" ]]; then
  name="${@: -1}"
  printf '%s/%s\n' "$PLOYDOK_DR_FAKE_VOLUMES" "$name"
elif [[ "$1" == "compose" && " $* " == *" ps --services "* ]]; then
  printf '%s\n' api web agent caddy postgres redis registry prometheus alertmanager
elif [[ "$1" == "compose" && " $* " == *" ps -q "* ]]; then
  printf 'fake-monitoring-container\n'
elif [[ "$1" == "compose" && " $* " == *" pg_dump "* ]]; then
  printf 'fake-postgres-dump\n'
elif [[ "$1" == "compose" && " $* " == *" psql "* && " $* " == *" SELECT "* ]]; then
  printf '0\n'
elif [[ "$1" == "ps" ]]; then
  :
elif [[ "$1" == "inspect" ]]; then
  printf 'healthy\n'
fi
EOF
chmod 0755 "$TMP/bin/docker"

cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$TMP/bin/id" <<'EOF'
#!/usr/bin/env bash
if [[ "${*: -1}" == "ploydok" && "$1" == "-u" ]]; then printf '1000\n'
elif [[ "${*: -1}" == "ploydok" && "$1" == "-g" ]]; then printf '1000\n'
else exec /usr/bin/id "$@"
fi
EOF
chmod 0755 "$TMP/bin/curl" "$TMP/bin/id"

printf 'durable-state\n' >"$TMP/payload/state.txt"
printf 'postgres-dump\n' >"$TMP/payload/postgres.dump"
mkdir -p "$TMP/payload/bind-volumes" "$TMP/payload/volumes" "$TMP/empty"
tar -C "$TMP/empty" -cf "$TMP/payload/install-dir.tar" .
for volume in app-volumes volumes; do
  tar -C "$TMP/empty" -cf "$TMP/payload/bind-volumes/$volume.tar" .
done
for volume in redis-data registry-data caddy-data caddy-config prometheus-data alertmanager-data; do
  tar -C "$TMP/empty" -cf "$TMP/payload/volumes/$volume.tar" .
done
cat >"$TMP/payload/manifest.env" <<'EOF'
PLOYDOK_DR_FORMAT=1
CREATED_AT=2026-08-18T00:00:00Z
SOURCE_RUNTIME=swarm
SOURCE_HOST=dr-test
DESCRIPTOR_SHA256=2d711642b726b04401627ca9fbac32f5da7e5f42987df13927ba1a2bfa0037a3
PLATFORM_IMAGE=ploydok-api:test
RPO_HOURS=24
RTO_HOURS=4
EOF
(cd "$TMP/payload" && find . -type f ! -name manifest.sha256 -print0 | sort -z | xargs -0 sha256sum >manifest.sha256)
tar -C "$TMP/payload" -czf "$TMP/backup.tar.gz.age" .
(cd "$TMP" && sha256sum backup.tar.gz.age >backup.tar.gz.age.sha256)
printf 'test-identity\n' >"$TMP/identity"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP/signing.key" >/dev/null 2>&1
openssl pkey -in "$TMP/signing.key" -pubout -out "$TMP/signing.pub" >/dev/null 2>&1
openssl dgst -sha256 -sign "$TMP/signing.key" -out "$TMP/backup.tar.gz.age.sig" "$TMP/backup.tar.gz.age"

output="$(
  PATH="$TMP/bin:$PATH" PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
    bash "$ROOT/installer/ploydok-cli" verify-control-plane-backup \
      --archive="$TMP/backup.tar.gz.age" \
      --age-identity="$TMP/identity" \
      --signing-public-key="$TMP/signing.pub"
)"
grep -Fq "Backup verified" <<<"$output"

printf 'tamper' >>"$TMP/backup.tar.gz.age"
if PATH="$TMP/bin:$PATH" PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
  bash "$ROOT/installer/ploydok-cli" verify-control-plane-backup \
    --archive="$TMP/backup.tar.gz.age" \
    --age-identity="$TMP/identity" \
    --signing-public-key="$TMP/signing.pub" >/dev/null 2>&1; then
  echo "tampered backup was accepted" >&2
  exit 1
fi

printf 'durable-state\n' >"$TMP/payload/state.txt"
cat >"$TMP/payload/manifest.env" <<EOF
PLOYDOK_DR_FORMAT=1
CREATED_AT=2026-08-18T00:00:00Z
SOURCE_RUNTIME=\$(touch$TMP/manifest-executed)
SOURCE_HOST=dr-test
DESCRIPTOR_SHA256=$(printf x | sha256sum | awk '{print $1}')
PLATFORM_IMAGE=ploydok-api:test
RPO_HOURS=24
RTO_HOURS=4
EOF
(cd "$TMP/payload" && find . -type f ! -name manifest.sha256 -print0 | sort -z | xargs -0 sha256sum >manifest.sha256)
tar -C "$TMP/payload" -czf "$TMP/malicious.tar.gz.age" .
(cd "$TMP" && sha256sum malicious.tar.gz.age >malicious.tar.gz.age.sha256)
openssl dgst -sha256 -sign "$TMP/signing.key" -out "$TMP/malicious.tar.gz.age.sig" "$TMP/malicious.tar.gz.age"
if PATH="$TMP/bin:$PATH" PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
  bash "$ROOT/installer/ploydok-cli" verify-control-plane-backup \
    --archive="$TMP/malicious.tar.gz.age" \
    --age-identity="$TMP/identity" \
    --signing-public-key="$TMP/signing.pub" >/dev/null 2>&1; then
  echo "unsafe manifest was accepted" >&2
  exit 1
fi
[[ ! -e "$TMP/manifest-executed" ]] || { echo "manifest executed as shell" >&2; exit 1; }

sed -i 's#^SOURCE_RUNTIME=.*#SOURCE_RUNTIME=swarm#' "$TMP/payload/manifest.env"
mkdir -p "$TMP/unsafe-inner"
ln -s ../../escape "$TMP/unsafe-inner/outside"
tar -C "$TMP/unsafe-inner" -cf "$TMP/payload/bind-volumes/app-volumes.tar" .
(cd "$TMP/payload" && find . -type f ! -name manifest.sha256 -print0 | sort -z | xargs -0 sha256sum >manifest.sha256)
tar -C "$TMP/payload" -czf "$TMP/unsafe-inner.tar.gz.age" .
(cd "$TMP" && sha256sum unsafe-inner.tar.gz.age >unsafe-inner.tar.gz.age.sha256)
openssl dgst -sha256 -sign "$TMP/signing.key" -out "$TMP/unsafe-inner.tar.gz.age.sig" "$TMP/unsafe-inner.tar.gz.age"
if PATH="$TMP/bin:$PATH" PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
  bash "$ROOT/installer/ploydok-cli" verify-control-plane-backup \
    --archive="$TMP/unsafe-inner.tar.gz.age" \
    --age-identity="$TMP/identity" \
    --signing-public-key="$TMP/signing.pub" >/dev/null 2>&1; then
  echo "unsafe nested archive was accepted" >&2
  exit 1
fi

if PLOYDOK_INSTALL_DRY_RUN=1 PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
  bash "$ROOT/installer/ploydok-cli" restore-control-plane \
    --archive=/tmp/test.tar.gz.age \
    --age-identity=/tmp/identity \
    --signing-public-key=/tmp/signing.pub \
    --verify-command=/tmp/verify \
    --data-dir=/ \
    --install-dir=/ \
    --yes >/dev/null 2>&1; then
  echo "root restore paths were accepted" >&2
  exit 1
fi

mkdir -p "$TMP/root/var/lib/ploydok" "$TMP/root/opt/ploydok" "$TMP/off-host" "$TMP/fake-volumes"
mkdir -p "$TMP/root/var/lib/ploydok"/{app-volumes,volumes,keys,pki,config,secrets,static,certs,caddy-ip-cert,backups}
printf 'PLOYDOK_RUNTIME_UID=1000\nPLOYDOK_RUNTIME_GID=1000\nPLOYDOK_PG_PASSWORD=%064d\n' 0 >"$TMP/root/var/lib/ploydok/.env"
printf 'master\n' >"$TMP/root/var/lib/ploydok/master.key"
printf 'metrics-secret\n' >"$TMP/root/var/lib/ploydok/secrets/metrics-token"
printf 'webhook-secret\n' >"$TMP/root/var/lib/ploydok/secrets/alert-webhook-url"
chmod 0400 "$TMP/root/var/lib/ploydok/secrets/metrics-token" "$TMP/root/var/lib/ploydok/secrets/alert-webhook-url"
if [[ "$(id -u)" -eq 0 ]]; then
  chown 65534:65534 "$TMP/root/var/lib/ploydok/secrets/metrics-token" \
    "$TMP/root/var/lib/ploydok/secrets/alert-webhook-url"
else
  sudo -n chown 65534:65534 "$TMP/root/var/lib/ploydok/secrets/metrics-token" \
    "$TMP/root/var/lib/ploydok/secrets/alert-webhook-url"
fi
printf 'app-volume-sentinel\n' >"$TMP/root/var/lib/ploydok/app-volumes/state"
printf 'managed-db-sentinel\n' >"$TMP/root/var/lib/ploydok/volumes/state"
cat >"$TMP/root/opt/ploydok/docker-compose.yml" <<'EOF'
services:
  api:
    image: ghcr.io/dev-toolings/ploydok-api:test
EOF
for volume in redis-data registry-data caddy-data caddy-config prometheus-data alertmanager-data; do
  mkdir -p "$TMP/fake-volumes/ploydok_$volume"
  printf '%s\n' "$volume" >"$TMP/fake-volumes/ploydok_$volume/state"
done
touch "$TMP/docker.log"

backup_runner=()
if [[ "$(id -u)" -eq 0 ]]; then
  backup_runner=(env)
elif sudo -n true >/dev/null 2>&1; then
  backup_runner=(sudo -n env)
else
  echo "passwordless sudo is required for the non-dry-run DR backup test" >&2
  exit 1
fi

"${backup_runner[@]}" \
  PATH="$TMP/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
  PLOYDOK_INSTALL_ROOT="$TMP/root" \
  PLOYDOK_DR_FAKE_VOLUMES="$TMP/fake-volumes" \
  PLOYDOK_DR_FAKE_DOCKER_LOG="$TMP/docker.log" \
  bash "$ROOT/installer/ploydok-cli" backup-control-plane \
    --destination="$TMP/off-host" \
    --age-recipient=age1testrecipient \
    --signing-key="$TMP/signing.key" \
    --retention-days=30 \
    --allow-local-destination >/dev/null

backup_archive="$(find "$TMP/off-host" -mindepth 2 -maxdepth 2 -name 'backup.tar.gz.age' -print -quit)"
[[ -n "$backup_archive" && -f "$backup_archive.sig" && -f "$backup_archive.sha256" ]] || {
  echo "non-dry-run backup did not produce its signed artifact set" >&2
  exit 1
}
grep -Fq "compose --env-file $TMP/root/var/lib/ploydok/.env" "$TMP/docker.log"
PATH="$TMP/bin:$PATH" PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
  bash "$ROOT/installer/ploydok-cli" verify-control-plane-backup \
    --archive="$backup_archive" \
    --age-identity="$TMP/identity" \
    --signing-public-key="$TMP/signing.pub" >/dev/null

printf 'non-empty-target\n' >"$TMP/root/var/lib/ploydok/app-volumes/state"
set +e
"${backup_runner[@]}" \
  PATH="$TMP/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
  PLOYDOK_INSTALL_ROOT="$TMP/root" \
  PLOYDOK_DR_FAKE_VOLUMES="$TMP/fake-volumes" \
  PLOYDOK_DR_FAKE_DOCKER_LOG="$TMP/docker.log" \
  bash "$ROOT/installer/ploydok-cli" restore-control-plane \
    --archive="$backup_archive" \
    --age-identity="$TMP/identity" \
    --signing-public-key="$TMP/signing.pub" \
    --verify-command="$TMP/verify-restored" \
    --yes >/dev/null 2>&1
non_empty_restore_status=$?
set -e
[[ "$non_empty_restore_status" -ne 0 ]] || { echo "non-empty restore target was accepted" >&2; exit 1; }
rm -f "$TMP/root/var/lib/ploydok/app-volumes/state" "$TMP/root/var/lib/ploydok/volumes/state"
for volume in redis-data registry-data caddy-data caddy-config prometheus-data alertmanager-data; do
  printf 'blank-target\n' >"$TMP/fake-volumes/ploydok_$volume/state"
done
cat >"$TMP/verify-restored" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 0755 "$TMP/verify-restored"

"${backup_runner[@]}" \
  PATH="$TMP/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
  PLOYDOK_INSTALL_ROOT="$TMP/root" \
  PLOYDOK_DR_FAKE_VOLUMES="$TMP/fake-volumes" \
  PLOYDOK_DR_FAKE_DOCKER_LOG="$TMP/docker.log" \
  bash "$ROOT/installer/ploydok-cli" restore-control-plane \
    --archive="$backup_archive" \
    --age-identity="$TMP/identity" \
    --signing-public-key="$TMP/signing.pub" \
    --verify-command="$TMP/verify-restored" \
    --yes >/dev/null

grep -Fq 'app-volume-sentinel' "$TMP/root/var/lib/ploydok/app-volumes/state"
grep -Fq 'managed-db-sentinel' "$TMP/root/var/lib/ploydok/volumes/state"
grep -Fq 'registry-data' "$TMP/fake-volumes/ploydok_registry-data/state"
grep -Fq ' up -d --force-recreate api web agent caddy postgres redis registry prometheus alertmanager' \
  "$TMP/docker.log"
[[ "$(stat -c '%u:%g:%a' "$TMP/root/var/lib/ploydok/secrets/metrics-token")" == "65534:65534:400" ]]
[[ "$(stat -c '%u:%g:%a' "$TMP/root/var/lib/ploydok/secrets/alert-webhook-url")" == "65534:65534:400" ]]

cat >"$TMP/verify-fails" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod 0755 "$TMP/verify-fails"
rm -f "$TMP/root/var/lib/ploydok/app-volumes/state" "$TMP/root/var/lib/ploydok/volumes/state"
: >"$TMP/docker.log"
set +e
"${backup_runner[@]}" \
  PATH="$TMP/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  PLOYDOK_DR_HELPER="$ROOT/installer/ploydok-dr" \
  PLOYDOK_INSTALL_ROOT="$TMP/root" \
  PLOYDOK_DR_FAKE_VOLUMES="$TMP/fake-volumes" \
  PLOYDOK_DR_FAKE_DOCKER_LOG="$TMP/docker.log" \
  bash "$ROOT/installer/ploydok-cli" restore-control-plane \
    --archive="$backup_archive" \
    --age-identity="$TMP/identity" \
    --signing-public-key="$TMP/signing.pub" \
    --verify-command="$TMP/verify-fails" \
    --yes >/dev/null 2>&1
failed_restore_status=$?
set -e
[[ "$failed_restore_status" -ne 0 ]] || { echo "failed restore verifier was ignored" >&2; exit 1; }
grep -F ' stop ' "$TMP/docker.log" | tail -n 1 | \
  grep -Fq ' stop api web agent caddy adminer registry redis prometheus alertmanager'

echo "disaster recovery archive tests OK"
