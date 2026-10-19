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

The host must already contain the reviewed `installer/ploydok-cli`,
`installer/migrate-stack-descriptor` at `/usr/local/lib/ploydok/migrate-stack-descriptor`,
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
   runtime port 8080. Turn off deploy on push.
2. Add the variable `SMOKE_BUILD_TOKEN` (any value) with the phase `build`.
3. Create an API token with the `apps:read` and `apps:deploy` scopes.
4. On the operator machine, write `~/.config/ploydok/smoke.env` (mode 0600):

   ```bash
   PLOYDOK_SMOKE_URL=http://192-168-1-235.sslip.io
   PLOYDOK_SMOKE_APP_ID=<id of the smoke app>
   PLOYDOK_SMOKE_TOKEN=<API token>
   ```

Without this file the wrapper prints a warning and skips the smoke test.
Environment variables with the same names override the file.
