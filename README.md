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
- [Features](#features)
- [Supported Stacks](#supported-stacks)
- [Install on a VPS](#install-on-a-vps)
- [Zero-Downtime Updates](#zero-downtime-updates)
- [Local Development](#local-development)
- [Architecture](#architecture)
- [Security Model](#security-model)
- [SEO Keywords](#seo-keywords)
- [Contributing](#contributing)

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
- Image signature verification in installer flows; immutable bootstrap and
  digest promotion remain release blockers.
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

## Install on a VPS

Production releases publish a signed bootstrap bundle after every image and
quality gate succeeds. Replace `1.2.3` below with an existing release:

Fork release verification uses `PLOYDOK_IMAGE_REGISTRY` to select the image
registry and `PLOYDOK_COSIGN_IDENTITY_REGEXP` to select the trusted GitHub release
workflow identity. Set both when installing a fork and pass the identity override
again when rerunning the installer or invoking `ploydok-cli`. For automatic stack
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

The webhook must be an HTTPS endpoint that accepts the standard Alertmanager
webhook payload. The installer refuses a production setup without an explicit
receiver, because silent alerts do not satisfy the production gate.

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
- configures authenticated Prometheus collection and Alertmanager paging;
- verifies the authenticated API scrape, Prometheus-to-Alertmanager discovery
  and receiver reachability from Alertmanager's egress network;
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

| Usage                                | CPU    | RAM   | Fast local storage |
| ------------------------------------ | ------ | ----- | ------------------ |
| Evaluation only                      | 2 vCPU | 2 GB  | 20 GB              |
| Small installation, light workloads  | 2 vCPU | 4 GB  | 40-60 GB           |
| Recommended starting point           | 4 vCPU | 8 GB  | 100 GB NVMe        |
| Several applications or frequent builds | 8 vCPU | 16 GB | 200 GB+ NVMe    |

The recommended starting point leaves headroom for BuildKit image builds,
Docker image and registry growth, Prometheus retention, and temporary overlap
during start-first or blue/green deployments. Application containers and
managed databases consume resources in addition to the control plane. A 4 GB
swap file can absorb short peaks on an 8 GB host, but it is not a substitute
for RAM under sustained load.

### Install Modes

| Mode             | Use when                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| `takeover`       | Ploydok should own ports 80 and 443. Existing nginx/apache config is backed up. |
| `coexist`        | Another edge proxy keeps TLS and forwards to Ploydok on local ports.            |
| `bootstrap-http` | Temporary first setup over HTTP from a controlled VPS security group.           |
| `abort`          | Preflight only. Prints what would happen and exits.                             |

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
make infra-up        # postgres + redis + caddy + buildkitd + registry + agent
make db-ensure-auth  # wait for postgres, realign the role if the volume drifted
make db-migrate      # apply database migrations
make check           # probe the whole stack and print the /setup URL
```

`make check` connects to Postgres and Redis, calls the Caddy admin and registry
APIs, stats the agent socket, compares applied migrations against the journal,
and — while no admin account exists — prints the first-boot wizard URL:

```
http://localhost:5173/setup
```

Outside production that URL needs no token: the page asks the API for a setup
session and the token is handed over in an `HttpOnly` cookie. In production the
token stays mandatory in the query string, and `make check` prints it from
`PLOYDOK_SETUP_TOKEN` (generated by `make secrets-init`) instead of the
30-minute one the API logs when the variable is unset.

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
├── apps/
│   ├── web/              # React 19, TanStack Start, TanStack Router
│   └── api/              # Bun, Hono, queues, auth, providers
├── packages/
│   ├── db/               # Drizzle schema and migrations
│   ├── shared/           # shared Zod schemas and domain types
│   ├── ui/               # shared UI components
│   └── agent-proto/      # gRPC contract and generated client types
├── agent/                # Rust agent and host CLI
├── installer/            # VPS installer, systemd and host templates
├── infra/                # local Postgres, Redis, Caddy, registry, BuildKit
└── scripts/              # validation and maintenance scripts
```

Runtime overview:

```text
Browser
  -> Ploydok web
  -> Ploydok API
  -> Rust agent over mTLS
  -> Docker / Docker Swarm
  -> App containers, database containers and Caddy routes
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
