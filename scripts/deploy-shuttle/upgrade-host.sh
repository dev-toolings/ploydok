#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Installed on VM 235 by the operator. It never copies host secrets off the VM.
set -Eeuo pipefail
[[ "$EUID" == 0 && "$(hostname -s)" == ploydok-staging-01 ]] || {
  echo 'This adapter is restricted to the existing Ploydok staging VM 235.' >&2
  exit 2
}
version="${1:?version is required}"
manifest="${2:?digest manifest is required}"
[[ "$version" =~ ^[a-zA-Z0-9_.-]+$ && -f "$manifest" ]] || exit 2
exec 9>/var/lock/ploydok-shuttle-upgrade.lock
flock -n 9 || { echo 'Another Ploydok Shuttle upgrade is running.' >&2; exit 3; }
count=0
while IFS='=' read -r key image; do
  case "$key" in PLOYDOK_API_IMAGE|PLOYDOK_WEB_IMAGE|PLOYDOK_AGENT_IMAGE|PLOYDOK_CADDY_IMAGE|PLOYDOK_ADMINER_IMAGE) ;; *) exit 2 ;; esac
  component="${key#PLOYDOK_}"
  component="${component%_IMAGE}"
  component="${component,,}"
  [[ "$image" =~ ^127\.0\.0\.1:5000/ploydok-${component}@sha256:[a-f0-9]{64}$ ]] || exit 2
  count=$((count + 1))
done <"$manifest"
[[ "$count" == 5 ]] || exit 2
backup="/var/lib/ploydok/backups/env.pre-shuttle-$version"
cp --preserve=mode,ownership /var/lib/ploydok/.env "$backup"
chmod 0600 "$backup"
sed -i 's/^PLOYDOK_SETUP_TOKEN_REQUIRED=.*/PLOYDOK_SETUP_TOKEN_REQUIRED=0/' /var/lib/ploydok/.env
if ! env PLOYDOK_INSTALL_SKIP_COSIGN=1 /usr/local/bin/ploydok-cli upgrade \
  --version="$version" --image-manifest="$manifest" --include-data-plane; then
  cp --preserve=mode,ownership "$backup" /var/lib/ploydok/.env
  echo 'Upgrade failed; previous setup configuration restored.' >&2
  exit 1
fi
bash /usr/local/lib/ploydok/verify-release-images "$manifest"
