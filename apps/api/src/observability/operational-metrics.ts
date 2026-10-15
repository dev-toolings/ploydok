// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm"
import { readFile, stat } from "node:fs/promises"
import type { Db } from "@ploydok/db"
import type { HostStatsResponse } from "@ploydok/agent-proto"
import { getSharedAgent } from "../debug/singletons"
import { buildHealthReport } from "./health"
import { counter, gauge } from "./metrics"
import type { HealthReport } from "./health"
import {
  backupAgeSeconds,
  backupFreshnessKey,
  backupMaxAgeSeconds,
  listBackupFreshness,
  timestampSeconds,
  type BackupFreshnessRow,
} from "../backups/freshness"

interface OperationalCounts extends Record<string, unknown> {
  deployments_total_15m: string | number
  deployments_failed_15m: string | number
  stuck_builds: string | number
  stuck_jobs: string | number
  backup_failures_24h: string | number
  stale_backup_resources: string | number
  outbox_pending: string | number
  outbox_stuck: string | number
  outbox_dead_lettered: string | number
  outbox_dead_lettered_15m: string | number
  certificates_expiring_30d: string | number
  certificates_expiring_7d: string | number
  certificates_expiring_1d: string | number
}

type HostStatsReader = () => Promise<HostStatsResponse>
type HealthReader = () => Promise<HealthReport>
interface ControlPlaneBackupStamps {
  configured: boolean
  lastSuccessTimestampSeconds: number
  lastFailureTimestampSeconds: number
}
type BackupStampReader = () => Promise<ControlPlaneBackupStamps>

const deploymentTotal = gauge(
  "ploydok_deployments_total_15m",
  "Deployments created during the last 15 minutes."
)
const deploymentFailed = gauge(
  "ploydok_deployments_failed_15m",
  "Failed deployments created during the last 15 minutes."
)
const stuckBuilds = gauge(
  "ploydok_stuck_builds",
  "Builds still pending more than 30 minutes after they were queued."
)
const stuckJobs = gauge(
  "ploydok_stuck_jobs",
  "Pending queue items older than 30 minutes plus scheduled runs beyond their configured timeout."
)
const backupFailures = gauge(
  "ploydok_backup_failures_24h",
  "Failed database and application-volume backups during the last 24 hours."
)
const staleBackupResources = gauge(
  "ploydok_stale_backup_resources",
  "Enabled backup resources without a successful backup during the last 24 hours."
)
const backupConfiguredAt = gauge(
  "ploydok_backup_configured_at_timestamp_seconds",
  "Unix timestamp when an enabled database or application-volume backup config was created."
)
const backupLastSuccess = gauge(
  "ploydok_backup_last_success_timestamp_seconds",
  "Unix timestamp of the latest successful backup for an enabled database or application-volume config, or zero when absent."
)
const backupAge = gauge(
  "ploydok_backup_age_seconds",
  "Age in seconds of the latest successful backup for an enabled database or application-volume config."
)
const backupMaxAge = gauge(
  "ploydok_backup_max_age_seconds",
  "Maximum tolerated age in seconds for an enabled database or application-volume backup config."
)
const controlPlaneBackupLastSuccess = gauge(
  "ploydok_control_plane_backup_last_success_timestamp_seconds",
  "Unix timestamp of the latest successful control-plane backup, or zero when absent."
)
const controlPlaneBackupConfigured = gauge(
  "ploydok_control_plane_backup_configured",
  "Whether the encrypted control-plane backup timer is configured."
)
const controlPlaneBackupLastFailure = gauge(
  "ploydok_control_plane_backup_last_failure_timestamp_seconds",
  "Unix timestamp of the latest failed control-plane backup, or zero when absent."
)
const outboxPending = gauge(
  "ploydok_outbox_pending",
  "Undelivered, non-dead-lettered outbox events."
)
const outboxStuck = gauge(
  "ploydok_outbox_stuck",
  "Available outbox events still undelivered after five minutes."
)
const outboxDeadLettered = gauge(
  "ploydok_outbox_dead_lettered",
  "Outbox events moved to the dead-letter state."
)
const outboxDeadLetteredRecent = gauge(
  "ploydok_outbox_dead_lettered_15m",
  "Outbox events moved to the dead-letter state during the last 15 minutes."
)
const certificatesExpiring = gauge(
  "ploydok_certificates_expiring",
  "Managed TLS certificates expiring within the labelled number of days."
)
const agentUp = gauge(
  "ploydok_agent_up",
  "Whether the authenticated API to agent RPC succeeds."
)
const componentReady = gauge(
  "ploydok_component_ready",
  "Whether a control-plane readiness component is healthy."
)
const hostDiskUsedRatio = gauge(
  "ploydok_host_disk_used_ratio",
  "Host Ploydok data filesystem used bytes divided by total bytes."
)
const hostInodesUsedRatio = gauge(
  "ploydok_host_inodes_used_ratio",
  "Host Ploydok data filesystem used inodes divided by total inodes."
)
const deploymentOutcomes = counter(
  "ploydok_deployment_outcomes_total",
  "Completed deployments classified by operator-actionable outcome."
)
const buildClaims = counter(
  "ploydok_build_claims_total",
  "Initial build claims classified by whether queue latency met the five-minute SLO."
)
for (const outcome of [
  "succeeded",
  "application_failed",
  "platform_failed",
  "cancelled",
] as const) {
  deploymentOutcomes.inc({ outcome }, 0)
}
for (const withinSlo of ["true", "false"] as const) {
  buildClaims.inc({ within_slo: withinSlo }, 0)
}
const scrapeError = gauge(
  "ploydok_operational_metrics_error",
  "Whether the operational metrics collector failed during the latest scrape."
)

function number(value: string | number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function setBackupFreshnessMetrics(
  rows: BackupFreshnessRow[],
  now: Date
): void {
  const seen = new Set<string>()

  for (const row of rows) {
    if (
      (row.resource_type !== "database" && row.resource_type !== "volume") ||
      !row.config_id ||
      !row.resource_id
    ) {
      continue
    }

    const labels = {
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      config_id: row.config_id,
    }
    const key = backupFreshnessKey(row)
    seen.add(key)
    const configuredAt = timestampSeconds(row.configured_at)
    const lastSuccess = timestampSeconds(row.last_success_at)
    const age = backupAgeSeconds(now, row.last_success_at)

    backupConfiguredAt.set(labels, configuredAt)
    backupLastSuccess.set(labels, lastSuccess)
    backupAge.set(labels, age)
    backupMaxAge.set(labels, backupMaxAgeSeconds())
  }

  for (const key of backupFreshnessSeries.keys()) {
    if (seen.has(key)) continue
    const labels = backupFreshnessSeries.get(key)!
    backupConfiguredAt.remove(labels)
    backupLastSuccess.remove(labels)
    backupAge.remove(labels)
    backupMaxAge.remove(labels)
    backupFreshnessSeries.delete(key)
  }

  for (const row of rows) {
    if (
      (row.resource_type !== "database" && row.resource_type !== "volume") ||
      !row.config_id ||
      !row.resource_id
    ) continue
    backupFreshnessSeries.set(backupFreshnessKey(row), {
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      config_id: row.config_id,
    })
  }
}

const backupFreshnessSeries = new Map<
  string,
  { resource_type: string; resource_id: string; config_id: string }
>()

export type DeploymentOutcome =
  | "succeeded"
  | "application_failed"
  | "platform_failed"
  | "cancelled"

export function recordDeploymentOutcome(outcome: DeploymentOutcome): void {
  deploymentOutcomes.inc({ outcome })
}

export function recordInitialBuildClaim(
  queuedAt: Date,
  claimedAt: Date = new Date()
): void {
  const latencyMs = Math.max(0, claimedAt.getTime() - queuedAt.getTime())
  buildClaims.inc({ within_slo: latencyMs <= 5 * 60 * 1_000 ? "true" : "false" })
}

async function defaultHostStats(): Promise<HostStatsResponse> {
  return getSharedAgent().hostStats({}, 1_000)
}

async function readStampTimestamp(
  path: string,
  emptyUsesMtime: boolean
): Promise<number> {
  try {
    const [contents, metadata] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ])
    const value = contents.trim()
    if (!value) return emptyUsesMtime ? metadata.mtimeMs / 1_000 : 0
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw new Error(`invalid backup stamp: ${path}`)
    return parsed / 1_000
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw error
  }
}

async function defaultBackupStamps(): Promise<ControlPlaneBackupStamps> {
  const directory =
    Bun.env.PLOYDOK_CONTROL_PLANE_BACKUP_STAMP_DIR ??
    "/var/lib/ploydok/backups"
  const [configuredTimestamp, lastSuccessTimestampSeconds, lastFailureTimestampSeconds] =
    await Promise.all([
      readStampTimestamp(`${directory}/control-plane.configured`, true),
      readStampTimestamp(`${directory}/control-plane.last-success`, false),
      readStampTimestamp(`${directory}/control-plane.last-failure`, true),
    ])
  return {
    configured: configuredTimestamp > 0,
    lastSuccessTimestampSeconds,
    lastFailureTimestampSeconds,
  }
}

export async function collectOperationalMetrics(
  db: Db,
  readHostStats: HostStatsReader = defaultHostStats,
  readHealth: HealthReader = () => buildHealthReport(db, "metrics"),
  readBackupStamps: BackupStampReader = defaultBackupStamps
): Promise<void> {
  let failed = false

  try {
    const rows = await db.execute<OperationalCounts>(sql`
      SELECT
        (SELECT count(*) FROM builds
          WHERE created_at >= now() - interval '15 minutes') AS deployments_total_15m,
        (SELECT count(*) FROM builds
          WHERE created_at >= now() - interval '15 minutes'
            AND status = 'failed') AS deployments_failed_15m,
        (SELECT count(*) FROM builds
          WHERE status = 'pending'
            AND queued_at < now() - interval '30 minutes') AS stuck_builds,
        ((SELECT count(*) FROM builds
            WHERE status = 'pending'
              AND queued_at < now() - interval '30 minutes')
          + (SELECT count(*) FROM system_jobs
            WHERE status = 'pending'
              AND queued_at < now() - interval '30 minutes')
          + (SELECT count(*) FROM app_delete_jobs
            WHERE status = 'pending'
              AND queued_at < now() - interval '30 minutes')
          + (SELECT count(*) FROM scheduled_job_runs run
              JOIN scheduled_jobs job ON job.id = run.job_id
            WHERE run.status = 'running'
              AND run.started_at < now()
                - make_interval(secs => job.timeout_seconds + 60))) AS stuck_jobs,
        ((SELECT count(*) FROM backups
            WHERE status = 'failed'
              AND started_at >= now() - interval '24 hours')
          + (SELECT count(*) FROM volume_backups
            WHERE status = 'failed'
              AND started_at >= now() - interval '24 hours')) AS backup_failures_24h,
        ((SELECT count(*) FROM backup_configs config
            WHERE config.enabled = true
              AND config.created_at < now() - interval '24 hours'
              AND NOT EXISTS (
                SELECT 1 FROM backups backup
                WHERE backup.config_id = config.id
                  AND backup.status = 'succeeded'
                  AND backup.finished_at >= now() - interval '24 hours'
              ))
          + (SELECT count(*) FROM volume_backup_configs config
            WHERE config.enabled = true
              AND config.created_at < now() - interval '24 hours'
              AND NOT EXISTS (
                SELECT 1 FROM volume_backups backup
                WHERE backup.config_id = config.id
                  AND backup.status = 'succeeded'
                  AND backup.finished_at >= now() - interval '24 hours'
              ))) AS stale_backup_resources,
        (SELECT count(*) FROM outbox_events
          WHERE delivered_at IS NULL AND dead_lettered_at IS NULL) AS outbox_pending,
        (SELECT count(*) FROM outbox_events
          WHERE delivered_at IS NULL AND dead_lettered_at IS NULL
            AND available_at < now() - interval '5 minutes') AS outbox_stuck,
        (SELECT count(*) FROM outbox_events
          WHERE dead_lettered_at IS NOT NULL) AS outbox_dead_lettered,
        (SELECT count(*) FROM outbox_events
          WHERE dead_lettered_at >= now() - interval '15 minutes') AS outbox_dead_lettered_15m,
        (SELECT count(*) FROM tls_certificates
          WHERE not_after <= now() + interval '30 days') AS certificates_expiring_30d,
        (SELECT count(*) FROM tls_certificates
          WHERE not_after <= now() + interval '7 days') AS certificates_expiring_7d,
        (SELECT count(*) FROM tls_certificates
          WHERE not_after <= now() + interval '1 day') AS certificates_expiring_1d
    `)
    const row = Array.from(rows)[0]
    if (!row) throw new Error("operational metrics query returned no row")

    deploymentTotal.set(undefined, number(row.deployments_total_15m))
    deploymentFailed.set(undefined, number(row.deployments_failed_15m))
    stuckBuilds.set(undefined, number(row.stuck_builds))
    stuckJobs.set(undefined, number(row.stuck_jobs))
    backupFailures.set(undefined, number(row.backup_failures_24h))
    staleBackupResources.set(undefined, number(row.stale_backup_resources))
    outboxPending.set(undefined, number(row.outbox_pending))
    outboxStuck.set(undefined, number(row.outbox_stuck))
    outboxDeadLettered.set(undefined, number(row.outbox_dead_lettered))
    outboxDeadLetteredRecent.set(
      undefined,
      number(row.outbox_dead_lettered_15m)
    )
    certificatesExpiring.set(
      { within_days: "30" },
      number(row.certificates_expiring_30d)
    )
    certificatesExpiring.set(
      { within_days: "7" },
      number(row.certificates_expiring_7d)
    )
    certificatesExpiring.set(
      { within_days: "1" },
      number(row.certificates_expiring_1d)
    )
  } catch (error) {
    console.error("[operational-metrics] SQL collection failed", error)
    failed = true
  }

  try {
    const freshnessRows = await listBackupFreshness(db)
    setBackupFreshnessMetrics(freshnessRows, new Date())
  } catch (error) {
    console.error("[operational-metrics] backup freshness collection failed", error)
    failed = true
  }

  try {
    const stamps = await readBackupStamps()
    controlPlaneBackupConfigured.set(undefined, stamps.configured ? 1 : 0)
    controlPlaneBackupLastSuccess.set(
      undefined,
      stamps.lastSuccessTimestampSeconds
    )
    controlPlaneBackupLastFailure.set(
      undefined,
      stamps.lastFailureTimestampSeconds
    )
  } catch (error) {
    console.error("[operational-metrics] backup stamp collection failed", error)
    failed = true
    controlPlaneBackupConfigured.set(undefined, 0)
    controlPlaneBackupLastSuccess.set(undefined, 0)
    controlPlaneBackupLastFailure.set(undefined, 0)
  }

  try {
    const stats = await readHostStats()
    agentUp.set(undefined, 1)
    if (stats.error) failed = true
    if (stats.diskTotalBytes > 0) {
      hostDiskUsedRatio.set(
        undefined,
        Math.min(1, stats.diskUsedBytes / stats.diskTotalBytes)
      )
    } else {
      failed = true
    }
    if (stats.inodesTotal > 0) {
      hostInodesUsedRatio.set(
        undefined,
        Math.min(1, stats.inodesUsed / stats.inodesTotal)
      )
    } else {
      failed = true
    }
  } catch (error) {
    console.error("[operational-metrics] agent host stats collection failed", error)
    failed = true
    agentUp.set(undefined, 0)
  }

  try {
    const report = await readHealth()
    for (const [component, state] of Object.entries(report.components)) {
      componentReady.set({ component }, state.status === "ok" ? 1 : 0)
    }
  } catch (error) {
    console.error("[operational-metrics] readiness collection failed", error)
    failed = true
    for (const component of ["db", "agent", "caddy", "ingress"]) {
      componentReady.set({ component }, 0)
    }
  }

  scrapeError.set(undefined, failed ? 1 : 0)
}
