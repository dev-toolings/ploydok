# Ploydok production operations

This runbook applies to the first production milestone: one Docker Swarm node
on Debian 12 or Ubuntu 24.04 LTS. It does not claim high availability.

## Monitoring architecture

```text
╔══════════════════ Control plane host ══════════════════╗
║                                                       ║
║  ┌───────────┐  HTTP/Bearer scrape   ┌─────────────┐  ║
║  │ Prometheus│ ─────────────────────▶ │ API metrics │  ║
║  └─────┬─────┘                        └──────┬──────┘  ║
║        │ alert rules                        │ SQL+mTLS ║
║        ▼                                    ▼         ║
║  ┌────────────┐  configured webhook  ┌─────────────┐  ║
║  │Alertmanager│ ────────────────────▶ │ Pager target│  ║
║  └────────────┘                       └─────────────┘  ║
╚═══════════════════════════════════════════════════════╝
```

Legend: Prometheus collects; Alertmanager routes; the API aggregates Postgres
state and authenticated agent host statistics. Components: Prometheus,
Alertmanager, Ploydok API, Postgres, Rust agent and the operator pager target.

The installer must generate `PLOYDOK_METRICS_TOKEN` and configure the scrape
without exposing the token or `/metrics` publicly. Installation supports
an optional HTTPS alert receiver. Without one, installation and upgrades continue
with a warning and Alertmanager uses a disabled receiver. Enable notifications
by rerunning the installer with `--alert-webhook-url=<https-url>` or
`PLOYDOK_ALERT_WEBHOOK_URL`; the URL is saved in
`/var/lib/ploydok/secrets/alert-webhook-url`. The
scrape uses authenticated HTTP only on the internal, non-attachable monitoring
network. Only Alertmanager joins the separate egress-enabled alerting network.
When a receiver is configured, each install and upgrade sends a labelled test
notification and fails if the receiver does not accept it.

## Initial service objectives

These objectives are intentionally compatible with a supported single-node
topology. Planned host maintenance is excluded only when announced before the
maintenance window.

| Indicator               | Objective                                                           | Window                              |
| ----------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| Control-plane readiness | 99.5% successful probes                                             | rolling 30 days                     |
| Agent authenticated RPC | 99.5% successful probes                                             | rolling 30 days                     |
| Deployment completion   | 95% finish without platform failure                                 | rolling 30 days, minimum 20 deploys |
| Queue latency           | 95% of builds claimed within 5 minutes                              | rolling 7 days                      |
| Backup freshness        | every protected resource has a successful backup under 24 hours old | continuous                          |

Evaluate the objectives from Prometheus with these initial SLIs:

```promql
avg_over_time(ploydok_component_ready[30d])
avg_over_time(ploydok_agent_up[30d])
(sum(increase(ploydok_deployment_outcomes_total[30d]))
  - sum(increase(ploydok_deployment_outcomes_total{outcome="platform_failed"}[30d])))
  / sum(increase(ploydok_deployment_outcomes_total[30d]))
sum(increase(ploydok_build_claims_total{within_slo="true"}[7d]))
  / sum(increase(ploydok_build_claims_total[7d]))
ploydok_stale_backup_resources == 0
```

The deployment counter classifies permanent application/build-input failures
separately from retryable or unknown platform failures. Paging uses only the
`platform_failed` outcome; application failures remain product feedback.

The initial recovery targets are **RPO 24 hours** and **RTO 4 hours**. They are
not considered achieved until the encrypted off-host backup and fresh-host
restore drill in `PRD-PLAN.md` pass with release-candidate artifacts.

## Disaster recovery

Install `age`, `openssl` and `jq`. Create an age identity whose private key is
held outside the Ploydok server. Create a distinct RSA signing key on the source
host (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072`) and pin
its exported public key in the recovery environment. Encryption protects the
payload; the required signature authenticates its source before decryption.
Mount remote NFS, CIFS, SSHFS, rclone or S3FS storage. The backup command rejects
Ploydok state paths and non-remote filesystems by default.
`--allow-local-destination` exists only for an isolated restore drill; it is not
a production backup.

```bash
sudo ploydok-cli configure-control-plane-backups \
  --destination=/mnt/off-host/ploydok \
  --age-recipient=age1... \
  --signing-key=/run/secrets/ploydok-backup-signing-key \
  --retention-days=30
```

This installs a persistent systemd timer for one backup every day at 02:00 UTC
with a randomized delay of up to 30 minutes. Run
`systemctl start ploydok-backup.service` for an immediate backup. The service
briefly quiesces mutation services, creates a custom-format
Postgres dump, and captures Redis, registry, Caddy and monitoring volumes plus
application volumes, keys, certificates and configuration. BuildKit cache,
logs and prior backups are reconstructible or recursive and are excluded. The
result is an age-encrypted archive, an external SHA-256 checksum and an internal
checksummed manifest. The command resumes services on both success and error.

Verify every produced object from a different host or trust boundary:

```bash
ploydok-cli verify-control-plane-backup \
  --archive=/mnt/off-host/ploydok/ploydok-control-plane-<timestamp>/backup.tar.gz.age \
  --age-identity=/run/secrets/ploydok-backup-identity \
  --signing-public-key=/run/secrets/ploydok-backup-signing-public-key
```

For a fresh-host drill, install the same release and runtime without creating
user resources, mount the off-host destination, then export a restored PAT and
the immutable identifiers recorded by the drill fixture:

```bash
export PLOYDOK_DR_API_ORIGIN=https://ploydok-recovery.example.com/api
export PLOYDOK_DR_TOKEN=plk_live_...
export PLOYDOK_DR_ORGANIZATION_ID=...
export PLOYDOK_DR_APP_ID=...
export PLOYDOK_DR_DATABASE_ID=...
export PLOYDOK_DR_APP_URL=https://restored-app.example.com
export PLOYDOK_DR_EXPECTED_APP_IP=203.0.113.10
export PLOYDOK_DR_APP_EXPECTED_BODY_SHA256=...
export PLOYDOK_DR_DATABASE_VERIFY_COMMAND=/root/check-restored-database-sentinel

sudo --preserve-env=PLOYDOK_DR_API_ORIGIN,PLOYDOK_DR_TOKEN,\
PLOYDOK_DR_ORGANIZATION_ID,PLOYDOK_DR_APP_ID,PLOYDOK_DR_DATABASE_ID,\
PLOYDOK_DR_APP_URL,PLOYDOK_DR_EXPECTED_APP_IP,\
PLOYDOK_DR_APP_EXPECTED_BODY_SHA256,PLOYDOK_DR_DATABASE_VERIFY_COMMAND \
  ploydok-cli restore-control-plane \
    --archive=/mnt/off-host/ploydok/ploydok-control-plane-<timestamp>/backup.tar.gz.age \
    --age-identity=/run/secrets/ploydok-backup-identity \
    --signing-public-key=/run/secrets/ploydok-backup-signing-public-key \
    --verify-command=/usr/local/lib/ploydok/verify-restored-platform \
    --yes
```

Restore first validates the asymmetric signature and encrypted-object checksum,
then decrypts and validates every payload checksum before changing state. It
accepts only a newly installed, empty host running the exact recorded release;
an in-place restore over live user resources is refused. A failed restore stays
quiesced instead of serving hybrid state. On success it restores the database
and durable volumes, requires control-plane readiness, then proves
authentication, exact expected resources, recovery-host DNS, the application
response sentinel and a managed-database data sentinel. Record archive age and elapsed restore time;
promotion fails above the 24-hour RPO or four-hour RTO. Run this drill for every
release candidate. A code path or dry run alone is not release evidence.

## Paging alerts and runbooks

All commands below are diagnostic unless a remediation step explicitly says
otherwise. Never delete volumes, prune Docker or rotate secrets as an automatic
first response.

### ControlPlaneNotReady

Trigger: `/health/ready` fails for 5 minutes.

1. Run `curl -fsS https://<control-plane>/health/ready` from the monitoring
   network and record the failing component.
2. Inspect `docker service ps ploydok_api ploydok_caddy ploydok_postgres` and
   the corresponding service logs.
3. If Postgres is unavailable, stop deployment mutations and follow the
   restore procedure; do not recreate its volume.
4. Resolve the named component, then require ten consecutive healthy probes
   before closing the incident.

### AgentDisconnected

Trigger: `ploydok_agent_up == 0` for 2 minutes.

1. Check `docker service ps ploydok_agent` and agent logs.
2. Run `sudo ploydok-cli check-agent-pki --warn-days=30` on the host.
3. Verify the API client certificate, agent certificate and CA mounts are
   readable only by their intended runtime identities.
4. Rotate PKI only for expiry or suspected compromise; after rotation, require
   authenticated readiness to recover before resuming deployments.

### HostDiskSaturation

Trigger: `ploydok_host_disk_used_ratio > 0.85` or
`ploydok_host_inodes_used_ratio > 0.85` for 10 minutes; bytes are critical above
0.95 for 5 minutes. Both series measure the dedicated host-data bind mount, not
the agent container overlay.

1. Record `df -h`, `df -i` and the largest Ploydok data directories.
2. Pause new deployments at the application layer.
3. Use the product's scoped registry/build-cache cleanup operations; verify the
   reference set before pruning.
4. Never run an unscoped `docker system prune` on a production host.

### DeploymentFailureRateHigh

Trigger: at least five deployments in 15 minutes and
the `platform_failed` share of `ploydok_deployment_outcomes_total` is above 0.25
for 10 minutes.

1. Group failures by application, source provider and build method.
2. Inspect the persisted build log and first platform error; redact credentials
   before sharing it.
3. If failures cross workspaces, pause the release/update path and roll back the
   control-plane candidate only through the tested upgrade procedure.
4. A repository-specific build error is a product notification, not a platform
   page, unless the same platform dependency is failing broadly.

### StuckJobs

Trigger: `ploydok_stuck_jobs > 0` or `ploydok_outbox_stuck > 0` for 10 minutes.
The jobs gauge counts queue items pending over 30 minutes and scheduled runs
past their configured timeout plus a 60-second cleanup margin; it does not infer
that an ordinary running deployment is stuck without a heartbeat signal.

1. Inspect worker logs and the affected rows, including lease token, heartbeat,
   attempt count and cancellation state.
2. Confirm Redis and Postgres readiness.
3. Do not manually mark a job successful. Let the fenced reconciler reclaim it
   or cancel it through the supported API.
4. `ploydok_outbox_dead_lettered_15m > 0` pages on a recent transition; the
   cumulative `ploydok_outbox_dead_lettered` gauge remains available for audit.

### BackupFailureOrStale

Trigger: `ploydok_backup_failures_24h > 0`, no successful protected-resource
backup exists within the 24-hour RPO, the control-plane success stamp is older
than 24 hours, or its failure stamp is newer than its success stamp. The
control-plane rule is gated by `ploydok_control_plane_backup_configured`, so a
fresh installation does not page before its backup timer is configured.

1. Verify destination connectivity, free space, credentials and encryption
   recipient without printing secrets.
2. Retry through the supported backup job and verify checksum plus off-host
   object existence.
3. A successful upload is not closure: schedule a restore verification and
   record its duration against the four-hour RTO.
4. For the control plane, compare the timestamps exported by
   `ploydok_control_plane_backup_last_success_timestamp_seconds` and
   `ploydok_control_plane_backup_last_failure_timestamp_seconds`; a newer
   failure remains actionable until a subsequent success refreshes the stamp.

### CertificateExpiring

Trigger: `ploydok_certificates_expiring{within_days="30"} > 0`, escalating at 7
days and paging critically at 1 day.

1. Identify the affected domain and certificate issuer from the database and
   Caddy logs.
2. Verify DNS, public reachability and ACME rate-limit responses.
3. For API-to-agent PKI, use the dedicated check/rotation commands instead of
   the public-certificate flow.
4. Confirm the renewed certificate is served externally before resolving.

### OperationalMetricsCollectorError

Trigger: `ploydok_operational_metrics_error == 1` or an expected operational
series is absent for 5 minutes.

1. Treat missing telemetry as an incident; do not assume zero failures.
2. Inspect API logs for Postgres query or authenticated agent RPC failure.
3. Cross-check `/health/ready`; resolve the dependency and require the metric to
   return to zero.

## Application domain readiness

The application creation wizard checks the selected generated or custom hostname
against application, alias and service ownership before continuing. Creation
checks ownership again under a database lock. A successful preview is not a
reservation, and missing DNS does not prevent creating the application.

Use the records displayed by the wizard to point the hostname at the instance.
DNS readiness is based on a real lookup. TLS is reported as issued only after
a verified certificate handshake; HTTP instances report TLS as not required.
The final URL follows the instance public scheme and port.

Workers apply routing only after the new runtime passes its health gate.
Failure to apply the primary Caddy route aborts the switch and compensates the
new runtime. DNS, certificate and alias problems leave the healthy application
running with a separate `action_required` routing state. A blocked Docker
switch retains the previous container until routing can be rechecked.

Custom primary hosts require matching DNS or the application's verified TXT
ownership proof before route registration and certificate provisioning. CDN
addresses are reported as unknown rather than mismatched; they still require
ownership proof. Generated hosts under the instance base and `.localhost`
hosts skip this DNS gate and report DNS as unknown. Check the domain from the
application banner after fixing DNS or certificate provisioning.

The preview never opens a TLS connection with the proposed hostname as SNI.
Only an authorized, healthy runtime with a registered route can trigger a TLS
probe, preventing previews from initiating on-demand ACME issuance.

Successful builds retain their primary hostname for rollback. A restored
container or service must become healthy before routing switches to it. Legacy
builds without a hostname snapshot retain the application's current hostname.
Existing installed application domains are not rewritten by the migration.
Migration 0086 backfills their source using the configured instance base and
marks legacy running apps for a routing recheck instead of inventing DNS/TLS
evidence. Only the latest successful build receives a missing hostname snapshot.
The migration preflight refuses case-insensitive duplicate app domains with
the affected app IDs. Choose one owner, change or clear the other domains, and
rerun `bun --env-file=apps/api/.env.local run db:migrate`; no loser is selected
automatically. Both API startup and the migration CLI run this read-only check.
Migration 0087 records whether the published runtime actually has a healthcheck.
Compose preserves the entrypoint's declared check instead of injecting shell
commands. A runtime without one is ready when running; configured checks must
report healthy, including during a routing recheck.

## Monitoring upgrades

The signed installer is the migration mechanism for runtime descriptors,
monitoring networks, rules and receiver configuration. Re-run the installer for
the target release before `ploydok-cli upgrade`; existing secrets are reused
when no new receiver URL is supplied. The CLI refuses a missing or legacy
monitoring schema instead of silently deploying stale rules. Installer and CLI
both recreate/force-update Prometheus and Alertmanager so replaced bind-mounted
configs and corrected secret modes take effect. They then require the
authenticated API scrape, active Alertmanager discovery, an alert accepted by
Alertmanager and receiver reachability from its egress network.

## Burn-in evidence

Before stable promotion, keep the release candidate under these alerts for at
least 72 hours. Attach alert history, deployment counts, backup results and one
restore-drill record to the release evidence. Silence periods must name an
incident or maintenance window and must not hide a failed production gate.
