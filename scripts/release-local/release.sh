#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version= push=0 stable=0 smoke=0
images=()
help() {
  cat <<'HELP'
Usage: release.sh --version VERSION [--image api|web|agent|caddy|adminer]...
                  [--root PATH] [--push] [--allow-stable] [--smoke-api]
Build linux/amd64 and linux/arm64, scan both, then optionally push all.
Default: all five images. Requires Docker buildx; push also needs skopeo.
Registry login is the caller's job. No signing or Git operations are performed.
All temporary artifacts and the dedicated build cache are removed on exit.
HELP
}
log() { printf '\033[36m[release]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[release] %s\033[0m\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --help|-h) help; exit 0 ;;
    --version|--root|--image)
      (($# >= 2)) || die "missing value for $1"
      case "$1" in
        --version) version="$2" ;;
        --root) root="$2" ;;
        --image) images+=("${2#ploydok-}") ;;
      esac
      shift 2 ;;
    --push) push=1; shift ;;
    --allow-stable) stable=1; shift ;;
    --smoke-api) smoke=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || die 'use a semantic version'
[[ "$version" == *-* || "$stable" == 1 ]] || die 'stable versions require --allow-stable'
((${#images[@]})) || images=(api web agent caddy adminer)
for image in "${images[@]}"; do
  case "$image" in api|web|agent|caddy|adminer) ;; *) die "unknown image: $image" ;; esac
done
for command in docker; do command -v "$command" >/dev/null || die "$command is required"; done
if ((push)); then command -v skopeo >/dev/null || die 'skopeo is required for --push'; fi
root="$(cd "$root" && pwd)"
tmp="$(mktemp -d)"
builder="ploydok-release-$(date +%s)-$$"
trivy=aquasec/trivy:0.67.2
trivy_new=0
docker image inspect "$trivy" >/dev/null 2>&1 || trivy_new=1
local_tags=()
cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  log 'Removing task images, archives, Trivy cache and dedicated builder cache'
  for tag in "${local_tags[@]}"; do docker image rm "$tag"; done
  docker buildx prune --builder "$builder" -af
  docker buildx rm "$builder"
  ((trivy_new)) && docker image rm "$trivy"
  # Trivy runs as the invoking uid, so its cache remains removable.
  rm -rf "$tmp"
  log 'Disk usage after cleanup (bytes)'
  df -B1 "$root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
log 'Disk usage before build (bytes)'
df -B1 "$root"
docker buildx create --name "$builder" --driver docker-container >/dev/null
build_version="candidate-$(git -C "$root" rev-parse HEAD)"
for image in "${images[@]}"; do
  context="$root"
  case "$image" in
    api|web) dockerfile="$root/apps/$image/Dockerfile" ;;
    agent) dockerfile="$root/agent/Dockerfile.prod" ;;
    caddy|adminer) context="$root/infra/$image"; dockerfile="$context/Dockerfile" ;;
  esac
  target="ghcr.io/dev-toolings/ploydok-$image:$version"
  log "Building $target for linux/amd64,linux/arm64"
  docker buildx build --builder "$builder" --pull \
    --platform linux/amd64,linux/arm64 --file "$dockerfile" \
    --build-arg "PLOYDOK_BUILD_VERSION=$build_version" \
    --provenance=mode=max --sbom=true --tag "$target" \
    --output "type=oci,dest=$tmp/$image.tar" "$context"
  for arch in amd64 arm64; do
    log "Scanning $image linux/$arch"
    docker run --rm --user "$(id -u):$(id -g)" \
      -v "$tmp:/release" "$trivy" image \
      --db-repository ghcr.io/aquasecurity/trivy-db:2,mirror.gcr.io/aquasec/trivy-db:2 \
      --no-progress --cache-dir /release/trivy-cache --platform "linux/$arch" \
      --exit-code 1 --ignore-unfixed --severity CRITICAL --input "/release/$image.tar"
    log "PASS $image linux/$arch"
  done
  if [[ "$image" == api && "$smoke" == 1 ]]; then
    tag="ploydok-release-smoke:$builder"
    local_tags+=("$tag")
    docker buildx build --builder "$builder" --platform linux/amd64 \
      --file "$dockerfile" --build-arg "PLOYDOK_BUILD_VERSION=$build_version" \
      --tag "$tag" --load "$context"
    docker run --rm "$tag" bun --version
    docker run --rm --network none -e NODE_ENV=test "$tag" bun -e '
      await import("./src/index.ts");
      await import("drizzle-orm/postgres-js/migrator");
      await import("@ploydok/shared");
      await import("@ploydok/agent-proto");
      const fs = await import("node:fs");
      if (!fs.existsSync("/app/packages/db/migrations/meta/_journal.json")) throw Error("missing migrations");
      if (fs.readdirSync("/app/node_modules/.bun").some(n => n.startsWith("esbuild@") || n.startsWith("@esbuild+"))) throw Error("esbuild shipped");
      console.log("API runtime imports and migrations PASS");'
  fi
done
if ((push)); then
  # Preflight every immutable tag before publishing any image. Registry reads
  # fail closed except for an explicit manifest-not-found response.
  for image in "${images[@]}"; do
    target="ghcr.io/dev-toolings/ploydok-$image:$version"
    digest="sha256:$(skopeo inspect --raw "oci-archive:$tmp/$image.tar" | sha256sum | cut -d' ' -f1)"
    if docker buildx imagetools inspect "$target" >"$tmp/remote" 2>"$tmp/error"; then
      current="$(awk '$1 == "Digest:" {print $2; exit}' "$tmp/remote")"
      [[ "$current" == "$digest" ]] || die "refusing to overwrite $target ($current != $digest)"
    else
      grep -Eqi 'manifest unknown|not found' "$tmp/error" || die "cannot verify remote tag $target"
    fi
  done
  for image in "${images[@]}"; do
    target="ghcr.io/dev-toolings/ploydok-$image:$version"
    log "Pushing scanned archive to $target"
    skopeo copy --all --preserve-digests \
      --authfile "${DOCKER_CONFIG:-$HOME/.docker}/config.json" \
      "oci-archive:$tmp/$image.tar" "docker://$target"
  done
else
  log 'All selected images passed; no push requested'
fi
