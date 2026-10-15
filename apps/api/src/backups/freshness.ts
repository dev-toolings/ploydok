// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm"
import type { Db } from "@ploydok/db"

export const BACKUP_MAX_AGE_SECONDS = 24 * 60 * 60

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
        config.created_at AS configured_at
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
        config.created_at AS configured_at
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
      configured.configured_at
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
      configured.configured_at
  `)
  return Array.from(rows)
}

export function timestampSeconds(value: Date | string | null): number {
  if (value === null) return 0
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp / 1_000 : 0
}

/** The documented 24-hour RPO applies to every protected resource. */
export function backupMaxAgeSeconds(): number {
  return BACKUP_MAX_AGE_SECONDS
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
