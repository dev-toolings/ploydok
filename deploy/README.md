# Local PVE staging deployment

The existing Ploydok installation on VM 235 stays on its single-node Swarm.
Deploy Shuttle transfers the five locally built images to the VM's existing
loopback registry, then calls Ploydok's upgrader with a digest-pinned manifest.
No GitHub Actions publication is used for develop deployments.

The configuration is `deploy/shuttle-staging.json`. Its ED25519 key was verified
on 2026-10-15 using `pvecli vm agent exec 235` and matches the existing SSH target.
No VPS credentials or application secrets are stored locally by this workflow.

Use the `shuttle` on your PATH, installed with `make install` from a Shuttle
checkout that contains `deploy existing-stack`. There is one Shuttle binary for
every project; `SHUTTLE_BIN` overrides it for a one-off test build.

```bash
bash scripts/deploy-shuttle.sh --dry-run
bash scripts/deploy-shuttle.sh
```

Run from a clean, reviewed develop checkout. The wrapper keeps dated Trivy JSON
reports under `~/.local/state/ploydok/shuttle-scans/` and refuses an image with a
fixable critical vulnerability. Between runs it keeps the pinned scanner image,
the Trivy cache under `~/.cache/ploydok/trivy` (layer analysis dropped above
4 GiB) and Shuttle's `shuttle-ploydok-existing` builder, whose BuildKit cache is
capped at 20 GiB. An unchanged image keeps its running digest, so its service is
not restarted: Caddy publishes host ports and cannot restart without dropping
traffic. Local application image tags are removed after the run. It never prunes
shared builders, services or unrelated images.

The data plane is a standalone `ploydok-caddy` container managed by the agent.
The zero-replica `ploydok_caddy` Swarm service is its deployment descriptor:
image, bind/volume mounts and direct host-published ports remain in the stack
file. Never scale that descriptor up or connect a managed task to an overlay.
Standalone attachable-overlay endpoints go through Docker manager AttachNetwork;
managed task containers skip that allocation path and can duplicate a VIP/task IP.

The agent migrates legacy Caddy service tasks automatically at startup or on
attachment reconciliation. It preflights the local image and attachable networks,
scales the descriptor to zero, waits for task shutdown, and creates the standalone
container with all project networks. One ingress interruption is expected during
this migration (about 12 seconds on staging): plan a maintenance window for the
first production upgrade that ships this runtime. The shared admin Unix socket, certificate/config volumes and
static bind mount remain intact. `caddy run --resume` restores persisted dynamic
routes after all overlays are attached; API reconciliation also restores routes.

Subsequent project overlay joins/leaves use live container network operations.
They never change the service spec or replace Caddy. Stack deployments preserve
zero replicas, and the agent preserves runtime attachments when the descriptor
network list is reset. Only an image/runtime-configuration change replaces the
standalone container. Docker's `unless-stopped` policy covers daemon restarts;
the agent checks desired state every ten seconds. The agent image needs no Docker
CLI or extra runtime dependency. Explicit stack stop removes Caddy after the agent
has stopped, before waiting for stack network removal. DR quiesce pauses Caddy
alongside workloads so its persistent volumes stop changing during the snapshot.

Projects retain separate data-plane networks. Only ingress joins multiple project
networks. Ports 80/443 bind directly on the host through normal container port
publishing, preserving external client source addresses without Swarm routing-mesh
SNAT. The admin bridge continues using the shared Unix socket and management plane.

`/health/ready` now performs an uncached read-only agent inspection of every project
overlay. `ingress.network_issues` reports `address_collision`, the network, address,
and conflicting VIP/task endpoint. A collision makes ingress degraded and readiness
non-green even if all routes exist. Inspection failure or a pending runtime revision makes ingress down. Upgrade
health gates on this readiness contract before verifying manifest digests. IPv4
and IPv6 endpoints are checked against all service VIPs and local task endpoints
under the supported single-node Swarm contract. Compose development is also supported.

See Docker's [managed-container attachment path](https://github.com/moby/moby/blob/a5b58c9/daemon/container_operations.go#L269-L325)
at the staging engine's reported source revision. The previous rollout attachment
implementation in b3ea587 is superseded by this lifecycle contract.

The host must already contain the reviewed `installer/ploydok-cli`,
`installer/migrate-stack-descriptor` at `/usr/local/lib/ploydok/migrate-stack-descriptor`,
`installer/templates/ploydok-stop-stack.sh` as `/usr/local/lib/ploydok/stop-stack.sh`,
`installer/verify-release-images` at `/usr/local/lib/ploydok/verify-release-images`,
and `scripts/deploy-shuttle/upgrade-host.sh` at
`/usr/local/bin/ploydok-shuttle-upgrade` (root-owned, executable). The adapter is
restricted to `ploydok-staging-01` and loopback registry images. It preserves an
environment backup and enables the tokenless first-admin setup requested for
staging. The normal upgrader backs up the database and stack descriptor, runs
migrations, deploys the images, verifies health and restores the descriptor on
failure. Existing database volumes, credentials and application state stay on
the VM. Local unsigned images use the explicit controlled-staging cosign exception;
official releases continue to require workflow signatures.

## Post-deploy smoke test

After a successful upgrade, `scripts/deploy-shuttle.sh` runs
`scripts/deploy-shuttle/smoke.ts`. It redeploys a reference app through the
public API, waits for its build and requires its public URL to answer
`ploydok-smoke …`. The app in `scripts/deploy-shuttle/smoke-app/` reproduces the
conditions that broke real deploys: a slim Node image without curl or wget, a
Dockerfile `ARG` without default, and a non-root process writing to `/tmp`.
A failed smoke test makes the wrapper exit non-zero; the upgrade itself is
already applied, so read the reported build error before retrying.

One-time setup on the staging instance:

1. Create an app from the `dev-toolings/ploydok` repository, branch `develop`,
   root directory `scripts/deploy-shuttle/smoke-app`, build method Dockerfile,
   runtime port 8080. Turn off deploy on push. When the instance has no GitHub
   installation covering `dev-toolings`, use a mirror of that folder that one
   of its installations can read: staging VM 235 uses the private repository
   `MakFly/ploydok-smoke-app` (root directory, branch `main`). Push any change
   of `scripts/deploy-shuttle/smoke-app/` to the mirror as well.
2. Add the variable `SMOKE_BUILD_TOKEN` (any value) with the phase `build`.
3. Create an API token with the `apps:read` and `apps:deploy` scopes
   (`apps:write` as well for the self-provisioning keys below).
4. On the operator machine, write `~/.config/ploydok/smoke.env` (mode 0600):

   ```bash
   PLOYDOK_SMOKE_URL=http://192-168-1-235.sslip.io
   PLOYDOK_SMOKE_APP_ID=<id of the smoke app>
   PLOYDOK_SMOKE_TOKEN=<API token>
   # Optional: recreate the app when someone deletes it from the UI.
   PLOYDOK_SMOKE_ORG_ID=<organization id>
   PLOYDOK_SMOKE_REPO=MakFly/ploydok-smoke-app
   PLOYDOK_SMOKE_INSTALLATION_ID=<GitHub installation id>
   PLOYDOK_SMOKE_BRANCH=main
   ```

Without this file the wrapper prints a warning and skips the smoke test.
Environment variables with the same names override the file. With the
optional keys, the script looks the app up by its name `ploydok-smoke` in the
organization and creates it (steps 1 and 2) when it is missing, so deleting
the smoke app from the UI no longer fails the next deploy.
