// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm"
import { CronExpressionParser } from "cron-parser"
import type { Db } from "@ploydok/db"

export const BACKUP_SCAN_INTERVAL_SECONDS = 30
export const BACKUP_SCAN_GRACE_SECONDS = BACKUP_SCAN_INTERVAL_SECONDS
/** Safety window used only when a legacy schedule cannot be parsed. */
export const INVALID_BACKUP_SCHEDULE_MAX_AGE_SECONDS = 24 * 60 * 60

export interface BackupFreshnessRow extends Record<string, unknown> {
  resource_type: "database" | "volume" | string
  config_id: string
  resource_id: string
  resource_name: string
  project_id: string
  owner_id: string
  schedule_cron: string
  configured_at: Date | string
  last_success_at: Date | string | null
  resource_status: string | null
}

/** Return the enabled database and volume configs with their last success. */
export async function listBackupFreshness(
  db: Db
): Promise<BackupFreshnessRow[]> {
  const rows = await db.execute<BackupFreshnessRow>(sql`
    WITH configured AS (
      SELECT
        'database'::text AS resource_type,
        config.id AS config_id,
        config.database_id AS resource_id,
        db_row.name AS resource_name,
        db_row.project_id,
        project_row.owner_id,
        config.schedule_cron,
        config.created_at AS configured_at,
        db_row.status AS resource_status
      FROM backup_configs config
      INNER JOIN databases db_row ON db_row.id = config.database_id
      INNER JOIN projects project_row ON project_row.id = db_row.project_id
      WHERE config.enabled = true
      UNION ALL
      SELECT
        'volume'::text AS resource_type,
        config.id AS config_id,
        config.volume_id AS resource_id,
        app_row.name || ':' || volume_row.name AS resource_name,
        app_row.project_id,
        project_row.owner_id,
        config.schedule_cron,
        config.created_at AS configured_at,
        app_row.status AS resource_status
      FROM volume_backup_configs config
      INNER JOIN apps app_row ON app_row.id = config.app_id
      INNER JOIN app_volumes volume_row ON volume_row.id = config.volume_id
      INNER JOIN projects project_row ON project_row.id = app_row.project_id
      WHERE config.enabled = true
    )
    SELECT
      configured.resource_type,
      configured.config_id,
      configured.resource_id,
      configured.resource_name,
      configured.project_id,
      configured.owner_id,
      configured.schedule_cron,
      configured.configured_at,
      configured.resource_status,
      max(
        CASE
          WHEN backup.status = 'succeeded' THEN backup.finished_at
          ELSE NULL
        END
      ) AS last_success_at
    FROM configured
    LEFT JOIN backups backup
      ON configured.resource_type = 'database'
      AND backup.config_id = configured.config_id
    WHERE configured.resource_type = 'database'
    GROUP BY
      configured.resource_type,
      configured.config_id,
      configured.resource_id,
      configured.resource_name,
      configured.project_id,
      configured.owner_id,
      configured.schedule_cron,
      configured.configured_at,
      configured.resource_status
    UNION ALL
    SELECT
      configured.resource_type,
      configured.config_id,
      configured.resource_id,
      configured.resource_name,
      configured.project_id,
      configured.owner_id,
      configured.schedule_cron,
      configured.configured_at,
      configured.resource_status,
      max(
        CASE
          WHEN volume_backup.status = 'succeeded' THEN volume_backup.finished_at
          ELSE NULL
        END
      ) AS last_success_at
    FROM configured
    LEFT JOIN volume_backups volume_backup
      ON configured.resource_type = 'volume'
      AND volume_backup.config_id = configured.config_id
    WHERE configured.resource_type = 'volume'
    GROUP BY
      configured.resource_type,
      configured.config_id,
      configured.resource_id,
      configured.resource_name,
      configured.project_id,
      configured.owner_id,
      configured.schedule_cron,
      configured.configured_at,
      configured.resource_status
  `)
  return Array.from(rows)
}

export function timestampSeconds(value: Date | string | null): number {
  if (value === null) return 0
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp / 1_000 : 0
}

/**
 * Return the tolerated age for one schedule. The window allows one and a half
 * schedule intervals plus one scheduler scan, while never falling below the
 * scan interval itself. Invalid legacy expressions retain the documented
 * explicit invalid-schedule fallback so a metrics or alerting pass cannot
 * fail closed. Callers can identify that configuration error from the
 * schedule itself without confusing it with a normal per-config threshold.
 */
export function backupMaxAgeSeconds(
  scheduleCron = "0 3 * * *",
  anchor = new Date()
): number {
  try {
    const interval = CronExpressionParser.parse(scheduleCron, {
      currentDate: anchor,
      tz: "UTC",
    })
    const first = interval.next().toDate()
    const second = interval.next().toDate()
    const scheduleIntervalSeconds =
      (second.getTime() - first.getTime()) / 1_000
    if (
      !Number.isFinite(scheduleIntervalSeconds) ||
      scheduleIntervalSeconds <= 0
    ) {
      return INVALID_BACKUP_SCHEDULE_MAX_AGE_SECONDS
    }
    return Math.max(
      BACKUP_SCAN_INTERVAL_SECONDS,
      Math.ceil(
        scheduleIntervalSeconds * 1.5 + BACKUP_SCAN_GRACE_SECONDS
      )
    )
  } catch {
    return INVALID_BACKUP_SCHEDULE_MAX_AGE_SECONDS
  }
}

export function backupIsStale(
  row: Pick<
    BackupFreshnessRow,
    "schedule_cron" | "configured_at" | "last_success_at"
  >,
  now: Date
): boolean {
  const maxAge = backupMaxAgeSeconds(row.schedule_cron, now)
  const lastSuccess = timestampSeconds(row.last_success_at)
  const reference = lastSuccess || timestampSeconds(row.configured_at)
  return reference > 0 && now.getTime() / 1_000 - reference > maxAge
}

export function backupAgeSeconds(
  now: Date,
  lastSuccess: Date | string | null
): number {
  const lastSuccessSeconds = timestampSeconds(lastSuccess)
  if (lastSuccessSeconds <= 0) return 0
  return Math.max(0, Math.floor(now.getTime() / 1_000 - lastSuccessSeconds))
}

export function backupFreshnessKey(
  row: Pick<BackupFreshnessRow, "resource_type" | "config_id">
): string {
  return `${row.resource_type}:${row.config_id}`
}
