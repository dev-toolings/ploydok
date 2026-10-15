# Local PVE staging deployment

The existing Ploydok installation on VM 235 stays on its single-node Swarm.
Deploy Shuttle transfers the five locally built images to the VM's existing
loopback registry, then calls Ploydok's upgrader with a digest-pinned manifest.
No GitHub Actions publication is used for develop deployments.

The configuration is `deploy/shuttle-staging.json`. Its ED25519 key was verified
on 2026-10-15 using `pvecli vm agent exec 235` and matches the existing SSH target.
No VPS credentials or application secrets are stored locally by this workflow.

Use a Shuttle build containing `deploy existing-stack`. The task-specific binary
lives at `~/.local/lib/ploydok-shuttle/shuttle`, keeping the normal `shuttle`
installation available to other projects. `SHUTTLE_BIN` overrides that path.

```bash
bash scripts/deploy-shuttle.sh --dry-run
bash scripts/deploy-shuttle.sh
```

Run from a clean, reviewed develop checkout. The wrapper keeps dated Trivy JSON
reports under `~/.local/state/ploydok/shuttle-scans/` and refuses an image with a
fixable critical vulnerability. It removes its scanner cache, newly pulled scanner
image, temporary builder/cache and local application image tags after the run.
It never prunes shared builders, services or unrelated images.

The host must already contain the reviewed `installer/ploydok-cli`,
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
