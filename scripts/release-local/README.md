# Local release images

Run from any directory:

```sh
scripts/release-local/release.sh --version 0.1.0-rc.2
scripts/release-local/release.sh --version 0.1.0-rc.2 --image api --image web --smoke-api
```

Requires Docker, buildx and support for both amd64 and arm64 builds
(native builder nodes or preconfigured binfmt emulation). Publishing also
requires skopeo and registry credentials in Docker's config.json. Docker
credential helpers must be available to skopeo if configured.

The Dockerfiles, contexts, platforms, candidate build version, provenance and
SBOM settings match the CI matrix in `.github/workflows/release-images.yml`.
Each OCI archive is scanned for both platforms with `aquasec/trivy:0.67.2`
and `image --exit-code 1 --ignore-unfixed --severity CRITICAL`. CI's
`--ignore-unfixed` policy is retained; no vulnerability-specific exclusions
are added. The official GHCR database registry is tried before the Google
mirror to avoid slow mirror downloads. Every selected image must pass before any upload starts.

Authenticate yourself before adding `--push`:

```sh
gh auth token | docker login ghcr.io -u <user> --password-stdin
scripts/release-local/release.sh --version 0.1.0-rc.2 --push
```

Versions without a hyphen require `--allow-stable`. Existing remote version
tags must have the exact archive digest. Registry errors fail closed.
Preflight is not an atomic registry lock: do not run concurrent publishers
for the same version. Uploads can partially succeed if the registry fails.
No Git tag, branch push, release promotion or signing is performed.

Locally built images are not signed by the GitHub workflow identity.
Install them only in staging with `PLOYDOK_INSTALL_SKIP_COSIGN=1`.

`--root PATH` builds another checkout without copying this script there.
`--smoke-api` also loads a temporary amd64 API image and checks Bun, runtime
server entry import, runtime module imports and migration files without accessing a database.

Exit traps remove temporary images, OCI archives, the Trivy cache and this
run's dedicated buildx builder/cache, including on build or scan failure.
Existing images, shared builders and shared Docker services are preserved.
Disk usage is printed before and after. New BuildKit helper images may remain
shared by Docker; they are not deleted if owned by another build. SIGKILL and
host power loss cannot execute a shell trap.

Inspired by deploy-shuttle/scripts/release.sh and scripts/ci-local.sh:
small strict shell entrypoints with explicit release gates and caller-owned
publication credentials.
