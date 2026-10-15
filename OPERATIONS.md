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
| Backup freshness        | every protected application resource meets its configured freshness age | continuous                       |

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

### Application backup inventory and freshness

Database backup tabs and application-volume backup lists show whether each
archive is present at its configured destination, its verified size, and its
snapshot age. The inventory endpoint is `GET /backups/inventory`, with optional
`kind=database|volume`, `resourceId`, and volume `appId` filters. It requires
accepted project membership and the corresponding `databases:read` or
`apps:read` token scope. A response contains at most 200 recent successful
backup candidates. Local `stat` and S3 `HEAD` probes confirm presence; a missing
object is distinct from an unavailable destination. Probe errors leave the UI
in the unavailable state. Copying an old archive does not reset its displayed
age, which uses the older of the snapshot start and destination modification.
The API caches each destination probe for 60 seconds per backup and invalidates
that cache when the backup or destination configuration changes.
The web inventory query is cached and refreshed every five minutes. An explicit
Refresh action fetches the backup rows and destination inventory immediately.
The endpoint supports limit-only pagination: callers may request a bounded
result set up to 200 entries, but there is no offset or cursor. Resource-scoped
queries keep the UI response bounded while the cache avoids repeating probes.

Each enabled database or volume backup config is checked against its
schedule-derived maximum age, including resources that are stopped. For a valid
UTC cron schedule, the age is `max(30 seconds, ceil(1.5 * consecutive schedule
interval seconds + 30 seconds))`; invalid legacy expressions use the 24-hour
default. The API exposes that per-config age to the database list, and the UI
does not infer a fixed freshness window. The protection badge uses the newest
enabled config and successful backups from that same config. A recent failed or
running job does not reset the age of the last successful backup. A config with
no success becomes stale once its configured maximum age has elapsed. Per-config
Prometheus series feed
`BackupFailureOrStale` after its existing ten-minute hold. API channels that
subscribe to `backup.stale` receive the same condition through the resource's
project owner, with a four-hour repeat window per stale episode. An episode
changes when a new successful backup is recorded.

### Application backup restore drill

The application backup drill downloads one plain `pg_dumpall` object from an
S3-compatible destination, starts a new PostgreSQL container, restores the
dump, and checks an operator-supplied row-count manifest. It measures RPO from
the source snapshot timestamp and measures RTO from before the download until
all row counts pass. The remote object is never changed.

Garage is the local S3-compatible destination for development. Start only the
task-owned Garage project when it is absent; do not replace or reset shared
`infra-*` services. Prepare a source fixture, record its UTC snapshot timestamp, upload its
plain SQL dump, and remove the source before the drill starts. For an existing
application backup, use its recorded snapshot timestamp and independently
recorded expected table counts.

```bash
set -a
source /path/to/restore-drill.env
set +a
export SOURCE_SNAPSHOT_AT="${SOURCE_SNAPSHOT_AT:?set to the fixture UTC timestamp}"
export VERIFY_DATABASE=dev333_fixture
export EXPECT_ROWS=public.tenants:17,public.events:257
scripts/restore-postgres-drill.sh
```

The environment file must provide `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`TARGET_POSTGRES_PASSWORD`. Destination and verification settings also have
command-line options; credentials and the target password remain environment
variables. The command accepts repeated `--expect-rows schema.table:count`
options. `SOURCE_SNAPSHOT_AT` must come from the source fixture creation or
dump timestamp, never from the S3 upload timestamp. An object ending in `.age`
also requires `--age-identity` and a local `age` binary.

The script uses the short-lived `amazon/aws-cli` image for the download and
the `postgres:16-alpine` image for the fresh target. It tolerates only the
expected `postgres` role or database already-exists messages from a plain
`pg_dumpall`; any other SQL error fails the drill. By default it removes the
target container and temporary files on exit. `--keep-target` is available for
post-drill inspection and still requires the task-owned container name prefix.
The script passes secret environment names to Docker without placing their
values in the `docker run` argument list. Docker still stores those values in
the target container environment, which Docker daemon operators can inspect;
this drill does not provide secret-manager storage.

Measured local drill on 2026-10-15 UTC, with Garage v1.0.1 on loopback
and cached `postgres:16-alpine` and `amazon/aws-cli:2.17.65` images. The
task-owned source was removed before the drill and the downloaded object was
checked against the uploaded bytes:

```text
ROW_COUNT table=public.tenants expected=17 actual=17
ROW_COUNT table=public.events expected=257 actual=257
S3_OBJECT=s3://dev333-fix-drill/fixture/application.dump
SOURCE_SNAPSHOT_AT=2026-10-15T16:29:22.754Z
RPO_SECONDS=12
RTO_SECONDS=4
RESTORE_STATUS=verified
```

The source was a task-owned PostgreSQL 16 fixture with two related tables.
Its 6,400-byte plain `pg_dumpall` object was uploaded and downloaded with an
exact byte comparison. The source container was removed before the drill.
The restore target had fresh storage and received only the S3 object. The
measured RTO includes download, target startup, SQL restore and row-count
verification. Source, target and Garage were isolated task resources; existing
`infra-*` containers were not modified.

This proves the S3 recovery path on a fresh container, not recovery from loss
of this physical host: local Garage shares the same failure domain. Repeat
the command on a second host with independently stored credentials and a
remote S3 destination before claiming the production off-host recovery target.
This run used an unencrypted fixture; the optional age-decryption path was
not exercised. Image pulls, DNS changes and full platform recovery are outside
this four-second measurement. Task-owned fixtures were removed after the run;
repeat runs must create or select an independently stored backup and record
new timestamps, row counts, RPO and RTO rather than reuse these measurements.

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

Trigger: `ploydok_backup_failures_24h > 0`, an enabled application backup config
exceeds its schedule-derived maximum age, the control-plane success stamp is
older than 24 hours, or its failure stamp is newer than its success stamp. The
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
