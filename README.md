# Ploydok - Self-Hosted PaaS for Docker, Git Deploys, Databases and Blue/Green Rollouts

[![CI](https://github.com/dev-toolings/ploydok/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-toolings/ploydok/actions/workflows/ci.yml)
[![Integration](https://github.com/dev-toolings/ploydok/actions/workflows/ci-integration.yml/badge.svg)](https://github.com/dev-toolings/ploydok/actions/workflows/ci-integration.yml)
[![Release images](https://github.com/dev-toolings/ploydok/actions/workflows/release-images.yml/badge.svg)](https://github.com/dev-toolings/ploydok/actions/workflows/release-images.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)
[![Runtime: Docker Swarm](https://img.shields.io/badge/runtime-Docker%20Swarm-2496ED.svg)](https://docs.docker.com/engine/swarm/)
[![Stack: Bun Hono React](https://img.shields.io/badge/stack-Bun%20%2B%20Hono%20%2B%20React-black.svg)](./package.json)

Ploydok is a pre-release, open-source, self-hosted PaaS for deploying web
applications, APIs, background services and databases on your own VPS. It is
designed as a pragmatic alternative to Dokploy, Coolify, CapRover, Heroku,
Railway, Render and Vercel for teams that want Git-based deploys, Docker
runtime control, blue/green rollouts, framework guardrails and clear operations
without running Kubernetes.

Ploydok is being hardened toward the daily production workflow: connect a repository, deploy
an app, attach domains and databases, scale replicas, inspect logs, monitor
runtime health, recover safely, and keep the host clean over time.

> **Production readiness:** the current repository is suitable for development
> and controlled staging evaluation. It is not yet approved for public
> production workloads. The blocking security, recovery and release gates are
> tracked in [PRD-PLAN.md](./PRD-PLAN.md).

## Table of Contents

- [Why Ploydok](#why-ploydok)
- [Feature maturity](#feature-maturity)
- [Features](#features)
- [Supported Stacks](#supported-stacks)
- [Releases](#releases)
- [Install on a VPS](#install-on-a-vps)
- [Upgrade workflow (pre-release)](#upgrade-workflow-pre-release)
- [Local Development](#local-development)
- [Architecture](#architecture)
- [Security Model](#security-model)
- [SEO Keywords](#seo-keywords)
- [Contributing](#contributing)
- [License](#license)

## Why Ploydok

Ploydok is built for operators who want a small, inspectable deployment
platform instead of a large cluster stack.

| Need                       | Ploydok approach                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Deploy from GitHub         | Repository import, branch tracking and webhook deploys                             |
| Evaluate GitLab            | Backend and provider connection exist; the complete browser journey remains beta   |
| Deploy an OCI image        | Create an application directly from a public or authenticated image                |
| Run many frameworks        | Dockerfile, Nixpacks and framework-specific env guardrails                         |
| Scale apps over time       | Docker Swarm services, replicas, service updates and runtime monitoring            |
| Avoid downtime on deploy   | Blue/green runtime model and Swarm `start-first` updates                           |
| Keep storage under control | Runtime image cleanup, registry garbage collection and build cache hygiene         |
| Operate from a VPS         | One-line installer, systemd supervision, Caddy ingress, Postgres and Redis         |
| Keep accounts secure       | Password login, TOTP, backup codes, passkeys on HTTPS origins and session controls |

Ploydok currently targets one Docker Swarm node. Multi-node scheduling and
stateful rescheduling are not supported for the first production milestone.

## Feature maturity

| Classification | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| Stable         | Reachable and covered by production-path release tests          |
| Beta           | Reachable with explicit limitations or incomplete release proof |
| Planned        | Not presented as generally available                            |

| Capability                                                              | Maturity | Current limitation                                           |
| ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| GitHub application deploys                                              | Beta     | Mandatory release E2E still required                         |
| OCI image deploys                                                       | Beta     | Fresh-onboarding E2E still required                          |
| GitLab deploys                                                          | Beta     | Browser creation journey is not yet release-certified        |
| Domains, logs, shell, environment and storage                           | Beta     | Production isolation journey still requires release proof    |
| Managed databases and rollback                                          | Beta     | Restore and migration rollback evidence remains required     |
| Preview deployments                                                     | Beta     | Pull-request lifecycle coverage is incomplete                |
| Shared environment, scheduled jobs, event webhooks, API tokens and tags | Planned  | Backend/UI maturity varies; not part of the stable milestone |
| Compose application deployment                                          | Planned  | No supported runtime contract yet                            |
| Multi-node Swarm                                                        | Planned  | First release is explicitly single-node                      |

## Features

### Application Deployments

- Deploy web apps, APIs and services from Git repositories.
- Dockerfile and Nixpacks build paths.
- Framework detection from repository files and manifests.
- Runtime env and secret handling for build-time and runtime phases.
- Production deployments and beta preview deployments.
- GitHub provider integration and webhook-driven auto-deploy.
- GitLab provider integration in beta while its browser journey is completed.

GitHub repository listing and cloning use short-lived installation access tokens
minted for the selected GitHub App installation. Organization claims use a
separate, short-lived GitHub user authorization only to prove that the user who
started the claim is an administrator of the GitHub organization; that user
token is not the repository or clone credential. Existing GitHub Apps must have
the App permission `Members: read` enabled before an organization can be
claimed. The owner of each existing organization installation must approve the
updated permission on GitHub, then the owner can retry the claim in Ploydok.
Personal `User` installations do not perform an organization membership check,
so they do not need this permission approval. Updating the permission does not
change the existing callback URLs: keep the App's `/github/app/callback` and
`/github/app/setup` values aligned with the configured API origin.

### Scaling and Rollouts

- Docker Swarm runtime mode for long-lived application services.
- Replica scaling per application.
- Blue/green deployment model.
- `start-first` updates for cleaner reloads.
- Healthcheck-aware deployment status.
- Runtime reconciliation so stale DB state follows real running services.

### Framework Guardrails

Ploydok adds framework-aware defaults before deploy so common 502s are caught
or repaired early.

- Laravel: `APP_KEY`, safe cache/session defaults when no external store exists.
- Symfony: `APP_SECRET`, `APP_ENV=prod`, `APP_DEBUG=0`.
- PHP: runtime port and web-root handling.
- Next.js: Node runtime defaults and container host binding.
- Hono and Node APIs: host/port/runtime guardrails.
- Python: Django, Flask and FastAPI process defaults.
- Rails and Phoenix: secret key checks.

### Databases and Services

- Provisioned databases managed as runtime resources.
- Connection reveal and database env injection.
- Adminer integration for database inspection.
- Runtime monitoring for app and database containers.

### Marketplace Templates

Marketplace installation resolves `template.toml` variables and environment
values, applies the first declared domain, and preserves its service/port as
the routing entrypoint. The **2026-10-14 snapshot** had **215/568 templates**
passing install-time validation (DSL resolution, runtime selection and Compose
planning). Deployment still depends on each template's runtime requirements.

Measure a cached catalog snapshot with:

```bash
bun run apps/api/scripts/marketplace-catalog-report.ts --json /tmp/marketplace-report.json
```

Add `--refresh` to fetch a new snapshot. Known limits are tracked in
**DEV-355 through DEV-359**: mount support, multiple domains, and unsupported
fields.

New marketplace `${domain}` values use `<slug>-<hash>.<base>`, sharing the app
domain source: `PLOYDOK_DOMAIN_BASE` first, otherwise an IPv4 public host becomes
`<ip-with-hyphens>.sslip.io`, a normal public hostname uses `apps.<hostname>`,
and local development falls back to `demo.localhost`. Generated public URLs use
`PLOYDOK_PUBLIC_SCHEME` and `PLOYDOK_PUBLIC_PORT`, including HTTP on port 8181 in
development or HTTP staging when configured. Caddy matches the hostname alone.
Explicit URLs to unrelated hosts keep their original scheme and port.

Existing installed services keep their stored domains and resolved Compose
values. This change performs no automatic migration and supplies no migration
script; an operator must explicitly reinstall or reconfigure an old service.

Compose dependencies preserve `service_started`, `service_healthy` (an explicit
usable healthcheck is required), and `service_completed_successfully`. Each
dependency edge has its own 300-second wait limit, with serial waits: five
successive waits can therefore take up to 25 minutes. Timeout errors identify
the dependency and its individual wait budget. Completion jobs preserve explicit
`restart: on-failure`; a nonzero exit is terminal immediately only with
`restart: "no"`. Successful existing one-shot jobs are inspected on resume and
are never restarted; resume is refused if the agent cannot inspect them.
Swarm dependency inspection requires an active single-node manager. Multi-node
clusters and unverifiable topologies are explicitly refused because container
health is available only from the local Docker node. API and agent must be
updated together for dependency readiness inspection.
Dependency failures roll back resources created by the deployment. If the
application deployment loses its lease during a wait, it stops creating services
and leaves existing services untouched to protect a successor's resources.
Inspect and reconcile any partial stack before retrying that deployment.

### Observability

- Workspace dashboard with application status, service health and deploy history.
- Monitoring page for runtime status, CPU, memory, uptime, restarts and images.
- Runtime logs and live status updates.
- Health pings and stale/offline agent states.
- Authenticated Prometheus collection, Alertmanager paging and measurable
  deployment/queue/backup SLIs; see the [operations runbooks](./OPERATIONS.md).

### Security and Operations

- Password login, TOTP, backup codes and passkey enrollment.
- WebAuthn passkeys on trusted HTTPS origins.
- HttpOnly access and refresh cookies.
- mTLS between API and agent in production TCP mode.
- Workflow-signed images, immutable digest manifests and promotion without
  rebuilding; signed bootstrap bundles for Git tags.
- Host CLI for upgrade and uninstall. Fresh-host recovery is not yet certified.

## Supported Stacks

Ploydok is framework-friendly rather than framework-locked. It can deploy any
containerized workload and has extra guardrails for popular stacks.

| Ecosystem                 | Examples                                               |
| ------------------------- | ------------------------------------------------------ |
| JavaScript and TypeScript | Next.js, Hono, Node.js APIs, React frontends           |
| PHP                       | Laravel, Symfony, generic PHP apps                     |
| Python                    | FastAPI, Flask, Django                                 |
| Ruby                      | Rails                                                  |
| Elixir                    | Phoenix                                                |
| JVM                       | Spring Boot through Dockerfile or build tooling        |
| Custom                    | Any app with a Dockerfile or compatible Nixpacks build |

## Releases

The [release-images workflow](./.github/workflows/release-images.yml) builds
`linux/amd64` and `linux/arm64` images at
`ghcr.io/dev-toolings/ploydok-{api,web,agent,caddy,adminer}`.

| Channel            | Trigger                      | Published image tags                | Gates                                         |
| ------------------ | ---------------------------- | ----------------------------------- | --------------------------------------------- |
| Stable             | Push `vX.Y.Z` Git tag        | `X.Y.Z`, `latest`                   | All gates                                     |
| Edge               | Push to `main`               | `edge`, `main-<short-sha>`          | All gates                                     |
| Develop prerelease | Manual dispatch on `develop` | Explicit version, e.g. `0.1.0-rc.1` | All gates by default; explicit skip available |

A main push or Git tag always runs the repository quality, Rust security/test,
installer, PostgreSQL/API integration, browser and accessibility gates.
Stable releases and changes to `main` require Kevin's explicit release request.

Every release also builds the images, rejects fixable CRITICAL vulnerabilities
with Trivy, signs the exact digests with keyless cosign, assembles the immutable
`release-images.env` workflow artifact, and promotes those digests without
rebuilding. Reusing a version tag with a different digest is refused; `edge`
and `latest` are the mutable channel aliases.

```text
.------------------------------------.
|  Select ref, version, gate policy  |
'------------------+-----------------'
                   |
                   v
.------------------+-----------------.
|   Quality and integration gates    |
|  Explicit prerelease skip allowed  |
'------------------+-----------------'
                   |
                   v
.------------------+-----------------.
|    Build, Trivy, sign, manifest    |
'------------------+-----------------'
                   |
                   v
.------------------+-----------------.
| Browser gates unless skip selected |
'------------------+-----------------'
                   |
                   v
.------------------+-----------------.
| Promote exact signed image digests |
'------------------------------------'
```

The agent's Rust compilation runs natively on `$BUILDPLATFORM` and
cross-compiles to each target with cargo-chef dependency caching. Do not
reintroduce an emulated Rust compiler. The API runtime installs production
workspace dependencies and excludes esbuild. API, web and agent runtime stages
upgrade OS packages. The image gate remains:

```bash
docker run --rm -e TRIVY_USERNAME -e TRIVY_PASSWORD \
  aquasec/trivy:0.67.2 image --exit-code 1 --ignore-unfixed --severity CRITICAL "$IMAGE"
```

### Development deployments

Until the official release, development deployments to Proxmox use Deploy
Shuttle from the local workstation. Validate changes locally before deployment.
GitHub Actions does not run on pushes or PRs targeting `develop`; manual CI
and image publication jobs also skip `develop`. Do not dispatch a prerelease
workflow from that branch. Release workflows for `main` and `v*` tags remain
enabled. Develop CI is restored only on explicit request.
See [the local staging procedure](deploy/README.md) for the Shuttle configuration
and verification commands.

### Install a prerelease

The GHCR packages are private. On a host with Docker installed, authenticate
in the root Docker credential context used by the installer. Use a token
restricted to `read:packages` for a GitHub account granted access to the
packages; never use a broad personal token:

```bash
read -r -p "GitHub username: " ghcr_user
read -r -s -p "GHCR read:packages token: " ghcr_token
printf '\n'
printf '%s' "$ghcr_token" | sudo docker login ghcr.io \
  -u "$ghcr_user" --password-stdin
unset ghcr_token
```

Use a reviewed checkout at the exact commit recorded by the successful
workflow run. From that checkout on the staging host:

```bash
version=0.1.0-rc.1
release_commit="REPLACE_WITH_THE_40_CHARACTER_WORKFLOW_COMMIT"
sudo env PLOYDOK_REF="$release_commit" \
  PLOYDOK_EXPECTED_COMMIT="$release_commit" PLOYDOK_VERSION="$version" \
  bash installer/bootstrap.sh --version="$version" \
  --image-registry=ghcr.io/dev-toolings --mode=coexist --yes
```

`PLOYDOK_VERSION` is required by the bootstrap when the source ref is a commit;
`--version` selects the installer image tag. Keep cosign verification enabled
for workflow-built prereleases. Choose an [install mode](#install-modes) that
matches the host; `coexist` leaves the existing edge proxy in control.

### Local pipeline fallback

When local release image builds are explicitly authorized, use the
[local release pipeline](./scripts/release-local/README.md):

```bash
scripts/release-local/release.sh --version 0.1.0-rc.local --platform linux/amd64
```

It builds all five images by default, scans each selected platform, and pushes
only with `--push` after every scan passes. Use repeated `--image api`,
`--image web` or another component name to select images. The platform default
matches CI (`linux/amd64,linux/arm64`). Publishing also requires skopeo and a
caller-managed registry login with package-write permission. Version tags are
immutable; versions without `-` require `--allow-stable`. A verification run
without `--push` discards its artifacts. To make images available to a staging
host, authenticate the publisher with package-write access and rerun the same
command with `--push`.

Exit traps remove temporary images, exported archives, the dedicated build
cache and Trivy cache, including on failure, and report disk usage before and
after. Shared Docker services, images and builders are preserved; shared helper
images can remain. Do not bypass cleanup or prune another project's cache.

Local images have no signature from the GitHub workflow identity. Install them
only in staging, using the same explicit `--version` and registry login as
above, with `PLOYDOK_INSTALL_SKIP_COSIGN=1` added to the `sudo env` command.

## Install on a VPS

Production releases publish a signed bootstrap bundle after every image and
quality gate succeeds. Authenticate to the private registry as described
in [Install a prerelease](#install-a-prerelease) before installing any channel.
Replace `1.2.3` below with an existing release:

Fork release verification uses `PLOYDOK_IMAGE_REGISTRY` to select the image
registry and `PLOYDOK_COSIGN_IDENTITY_REGEXP` to select the trusted GitHub release
workflow identity. Set both when installing a fork and pass the identity override
again when rerunning the installer or invoking `ploydok-cli`. Adjust the
bootstrap asset download URL and `verify-blob` identity for the fork as well.
For automatic stack
updates, set the identity override in the update service environment. The default
identity trusts
`https://github.com/dev-toolings/ploydok/.github/workflows/release-images.yml`.

```bash
version=1.2.3
alert_webhook_url="https://alerts.example.com/ploydok"
asset="ploydok-bootstrap-${version}.tar.gz"
base="https://github.com/dev-toolings/ploydok/releases/download/v${version}"
curl -fSLO "${base}/${asset}"
curl -fSLO "${base}/${asset}.sha256"
curl -fSLO "${base}/${asset}.sigstore.json"
sha256sum -c "${asset}.sha256"
cosign verify-blob \
  --bundle "${asset}.sigstore.json" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/dev-toolings/ploydok/\.github/workflows/release-images\.yml@refs/tags/v.*$' \
  "${asset}"
tmp_dir="$(mktemp -d)"
tar -C "$tmp_dir" -xzf "$asset"
commit="$(cat "$tmp_dir/COMMIT")"
sudo env PLOYDOK_REF="v${version}" PLOYDOK_EXPECTED_COMMIT="$commit" \
  PLOYDOK_VERSION="$version" PLOYDOK_ALERT_WEBHOOK_URL="$alert_webhook_url" \
  bash "$tmp_dir/bootstrap.sh"
```

Do not pipe a mutable branch directly into a root shell. `edge` remains
available only for controlled development evaluation through the explicit
`PLOYDOK_ALLOW_EDGE=1` opt-in.

Install in coexist mode when another proxy already owns ports 80 and 443:

```bash
sudo env PLOYDOK_REF="v${version}" PLOYDOK_EXPECTED_COMMIT="$commit" \
  PLOYDOK_VERSION="$version" PLOYDOK_ALERT_WEBHOOK_URL="$alert_webhook_url" \
  bash "$tmp_dir/bootstrap.sh" --mode=coexist --yes
```

Alerting is recommended for production and optional to install. Provide
`--alert-webhook-url=<https-url>` or `PLOYDOK_ALERT_WEBHOOK_URL` to enable it;
the receiver must use HTTPS and accept the standard Alertmanager webhook
payload. When omitted on a fresh install, the installer logs a WARN and
disables alerting. An existing receiver is retained when rerunning installation.
Omit `PLOYDOK_ALERT_WEBHOOK_URL` from the examples above if alerts are not needed.

The installer deploys the control plane as a single-node Docker
Swarm stack by default. Docker Compose remains available only for explicit
local and test workflows (`--runtime=compose`).

The installer:

- clones the installer into `/opt/ploydok-installer`;
- installs Docker when missing, unless `--skip-docker-install` is provided;
- creates the `ploydok` system user;
- writes runtime descriptors under `/opt/ploydok`;
- stores mutable data under `/var/lib/ploydok`;
- generates platform secrets and mTLS material;
- configures authenticated Prometheus collection and optional Alertmanager paging;
- verifies the authenticated API scrape and Prometheus-to-Alertmanager discovery;
- verifies receiver reachability when an alert webhook is configured;
- pulls and verifies platform images;
- renders Docker Compose and systemd units;
- starts the platform and waits for health checks;
- installs `ploydok-cli` on the host.

The disaster-recovery candidate is documented in [OPERATIONS.md](./OPERATIONS.md):
signed and encrypted off-host backups, checksum verification, 30-day retention
and a mandatory fresh-host restore drill before production approval.

### Host requirements

The installer requires at least 2 GB of RAM and 10 GB of free disk space. These
values are installation floors for evaluation only: it also warns below 4 GB
of RAM or 20 GB of free disk space.

For a useful single-node installation, size the host for both the Ploydok
control plane and the workloads it will run:

| Usage                                   | CPU    | RAM   | Fast local storage |
| --------------------------------------- | ------ | ----- | ------------------ |
| Evaluation only                         | 2 vCPU | 2 GB  | 20 GB              |
| Small installation, light workloads     | 2 vCPU | 4 GB  | 40-60 GB           |
| Recommended starting point              | 4 vCPU | 8 GB  | 100 GB NVMe        |
| Several applications or frequent builds | 8 vCPU | 16 GB | 200 GB+ NVMe       |

The recommended starting point leaves headroom for BuildKit image builds,
Docker image and registry growth, Prometheus retention, and temporary overlap
during start-first or blue/green deployments. Application containers and
managed databases consume resources in addition to the control plane. A 4 GB
swap file can absorb short peaks on an 8 GB host, but it is not a substitute
for RAM under sustained load.

The x86-64 CPU must expose AVX2 (x86-64-v3) to the guest: the API and web
images run on Bun. On Proxmox, set the VM CPU type to `host` (or
`x86-64-v3`); the default `kvm64` hides AVX2 and the Bun processes grow until
the kernel OOM killer stops them. Check with
`grep -o -w avx2 /proc/cpuinfo | head -1`.

### Install Modes

| Mode             | Use when                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| `takeover`       | Ploydok should own ports 80 and 443. Existing nginx/apache config is backed up. |
| `coexist`        | Another edge proxy keeps TLS and forwards to Ploydok on local ports.            |
| `bootstrap-http` | Temporary first setup over HTTP from a controlled VPS security group.           |
| `abort`          | Preflight only. Prints what would happen and exits.                             |

`--unattended` implies `--yes` and defaults to `coexist` when no `--mode` is
given. An explicit `--mode` takes precedence regardless of argument order.

Useful flags:

```bash
--unattended
--manage-firewall
--public-host=example.com
--public-scheme=https
--public-port=443
--http-port=8080
--https-port=8443
--install-dir=/opt/ploydok
--data-dir=/var/lib/ploydok
--version=<tag>
--image-registry=<registry>
--alert-webhook-url=<https-url>
```

For production, use a real HTTPS domain. Browser passkeys require a secure
WebAuthn-compatible origin. Raw HTTP on an IP address is only suitable for
temporary bootstrap access.

## Upgrade workflow (pre-release)

Run upgrades from the host with the installed CLI:

```bash
sudo ploydok-cli upgrade --version=1.2.3
```

Default upgrades aim to roll the control plane while keeping the data plane
stable. Database rollback compatibility and fresh-host restore remain required
release gates; take an independently stored backup before testing an upgrade.

| Component                                                        | During `upgrade`                       | Notes                                            |
| ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `ploydok-api`, `ploydok-web`, `ploydok-agent`, `ploydok-adminer` | restarted                              | New images are pulled and applied.               |
| `ploydok-caddy`                                                  | not restarted by default               | Use `--include-data-plane` for ingress releases. |
| `postgres`, `redis`                                              | not restarted unless image tags change | Patch releases usually leave them alone.         |
| User apps                                                        | not touched                            | Runtime app containers keep serving traffic.     |
| User databases                                                   | not touched                            | Provisioned databases keep running.              |

Safety checks:

- control-plane database snapshot before upgrade;
- compose file backup before upgrade;
- image signature verification;
- readiness check after upgrade;
- rollback to the previous compose file if readiness fails.

Uninstall while preserving data as a tarball:

```bash
sudo ploydok-cli uninstall --yes
```

Restore a previous nginx/apache edge proxy as part of uninstall:

```bash
sudo ploydok-cli uninstall --yes --restore-previous-proxy
```

## Local Development

Requirements:

- Bun 1.3 or newer
- Node.js 22 or newer for tooling
- Docker
- Rust stable for the agent and host CLI

Install and start everything in one step (dependencies + secrets + local infra +
credential check + migrations + stack verification + dev servers):

```bash
make install
```

`make install` ends by running the dev servers in the foreground, so it stays
attached until you press Ctrl-C. Use it on a fresh clone or after pulling
changes that touch infra or migrations. Before starting the servers it runs
`make check`, which probes every component for real and aborts the install if
one of them is down.

Or run the steps individually:

```bash
bun install          # workspace dependencies
make infra-up        # postgres + redis + caddy + registry + agent + buildx builder
make db-ensure-auth  # wait for postgres, realign the role if the volume drifted
make db-migrate      # apply database migrations
make check           # probe the whole stack and print the /setup URL
```

`make check` connects to Postgres and Redis, calls the Caddy admin and registry
APIs, stats the agent socket, compares applied migrations against the journal,
and, while no admin account exists, prints the first-boot wizard URL:

```
http://localhost:5173/setup
```

That URL needs no token. The first person to submit the form becomes the
admin, then registration closes. Set `PLOYDOK_SETUP_TOKEN_REQUIRED=1` to lock
the form behind a one-shot token. In that mode, outside production the page
asks the API for a setup session and the token is handed over in an `HttpOnly`
cookie. In production `make check` prints the token from `PLOYDOK_SETUP_TOKEN`
(generated by `make secrets-init`) instead of the 30-minute one the API logs
when the variable is unset.

Run the development servers on an already-installed checkout:

```bash
make dev
```

A postgres volume keeps the role password chosen at its first `initdb`, so
rotating `PLOYDOK_PG_PASSWORD` in `apps/api/.env.local` breaks authentication
until the role is realigned. `make db-ensure-auth` detects that mismatch and
repairs it in place, without touching your data.

Local ports:

| Service        | URL                             |
| -------------- | ------------------------------- |
| Web            | `http://localhost:5173`         |
| API            | `http://localhost:3335`         |
| Caddy admin    | `http://127.0.0.1:2020/config/` |
| Local registry | `http://127.0.0.1:5000/v2/`     |
| Postgres       | `127.0.0.1:5434`                |
| Redis          | `127.0.0.1:6381`                |

Useful commands:

```bash
bun test
bun run typecheck
bun run lint
bun run check:spdx
bun run audit:dependencies
bun run db:migrate
bun run db:generate
```

Agent and host CLI:

```bash
cd agent
cargo test
cargo build --release
```

## Architecture

```text
ploydok/
+-- apps/
|   +-- web/              # React 19, TanStack Start, TanStack Router
|   '-- api/              # Bun, Hono, queues, auth, providers
+-- packages/
|   +-- db/               # Drizzle schema and migrations
|   +-- shared/           # shared Zod schemas and domain types
|   +-- ui/               # shared UI components
|   '-- agent-proto/      # gRPC contract and generated client types
+-- agent/                # Rust agent and host CLI
+-- installer/            # VPS installer, systemd and host templates
+-- infra/                # local Postgres, Redis, Caddy, registry, BuildKit
'-- scripts/              # validation and maintenance scripts
```

Runtime overview:

```text
.-----------------------------------.
|      Browser and Ploydok web      |
'-----------------+-----------------'
                  |
                  v
.-----------------+-----------------.
|            Ploydok API            |
'-----------------+-----------------'
                  |
                  v
.-----------------+-----------------.
|        Rust agent over mTLS       |
'-----------------+-----------------'
                  |
                  v
.-----------------+-----------------.
|       Docker / Docker Swarm       |
'-----------------+-----------------'
                  |
                  v
.-----------------+-----------------.
|  Apps, databases and Caddy routes |
'-----------------------------------'
```

## Security Model

Ploydok is designed for production self-hosting, but the current pre-release
does not yet satisfy every production gate.

- Access token: 10 minutes.
- Refresh token: 7 days, rotating.
- Cookies: `HttpOnly`, `SameSite=Lax`, `Secure` when public origin is HTTPS.
- TOTP and backup codes for second-factor and recovery.
- Passkeys through WebAuthn on secure origins.
- Agent communication protected with mTLS in production TCP mode.
- Secrets encrypted at rest with the configured master key.
- SPDX `AGPL-3.0-only` headers enforced in CI.
- Responsible disclosure: see [SECURITY.md](./SECURITY.md).
- Production SLOs and paging runbooks: see [OPERATIONS.md](./OPERATIONS.md).

## SEO Keywords

Ploydok is relevant for searches around:

- self-hosted PaaS
- open-source PaaS
- Docker PaaS
- Docker Swarm PaaS
- Dokploy alternative
- Coolify alternative
- CapRover alternative
- Heroku alternative
- Railway alternative
- Render alternative
- Vercel alternative
- self-hosted deployment platform
- Git-based deployments
- blue/green deployments
- zero-downtime deploys
- Laravel hosting panel
- Symfony hosting panel
- Next.js self-hosting
- Hono deployment
- VPS app hosting
- Docker app hosting
- self-hosted CI/CD deployment platform

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). DCO sign-off is required:

```bash
git commit -s
```

## License

Ploydok is licensed under [AGPL-3.0-only](./LICENSE).
