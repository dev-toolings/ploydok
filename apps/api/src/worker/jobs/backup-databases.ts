// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from "drizzle-orm"
import { CronExpressionParser } from "cron-parser"
import {
  apps,
  databases,
  backup_configs,
  volume_backup_configs,
  createRedis,
  type Db,
} from "@ploydok/db"
import { childLogger } from "../../logger"
import { runBackupOnce, type BackupRunResult } from "../../databases/backup"
import { runVolumeBackupOnce } from "../../backups/volume"
import { dispatch } from "../../notify/index"
import { env } from "../../env"

const log = childLogger("backup.cron")
let interval: ReturnType<typeof setInterval> | null = null

/** Coalesce missed executions into the latest due UTC occurrence. */
export function latestBackupOccurrence(
  expression: string,
  createdAt: Date,
  lastScheduledAt: Date | null,
  now: Date
): Date | null {
  const due = CronExpressionParser.parse(expression, {
    currentDate: new Date(now.getTime() + 1),
    tz: "UTC",
  })
    .prev()
    .toDate()
  return due >= createdAt && (!lastScheduledAt || due > lastScheduledAt)
    ? due
    : null
}

/**
 * Hold a transaction-scoped lock until both the backup result and cursor commit.
 * A crash rolls back the cursor. Replays replace the same scheduled artifact
 * location instead of creating another copy of the interrupted backup.
 */
export async function runScheduledBackupConfig(
  db: Db,
  kind: "database" | "volume",
  configId: string,
  now: Date,
  run: (tx: Db, due: Date) => Promise<BackupRunResult>
): Promise<BackupRunResult | null> {
  return db.transaction(async (tx) => {
    const locks = await tx.execute<{ locked: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`backup:${kind}:${configId}`}, 0)) AS locked
    `)
    if (!locks[0]?.locked) return null
    const table = kind === "database" ? backup_configs : volume_backup_configs
    const [config] = await tx
      .select()
      .from(table)
      .where(eq(table.id, configId))
      .limit(1)
    if (!config?.enabled) return null
    const due = latestBackupOccurrence(
      config.schedule_cron,
      config.created_at,
      config.last_scheduled_at,
      now
    )
    if (!due) return null
    const result = await run(tx as unknown as Db, due)
    await tx
      .update(table)
      .set({ last_scheduled_at: due })
      .where(eq(table.id, configId))
    return result
  })
}

async function notifyBackup(
  db: Db,
  result: BackupRunResult,
  appId: string,
  appName: string,
  projectId: string
) {
  const redis = createRedis(env.REDIS_URL)
  try {
    await dispatch(
      db,
      redis,
      result.status === "succeeded" ? "backup.succeeded" : "backup.failed",
      {
        appId,
        appName,
        commitSha: result.backupId,
      },
      { userId: projectId, projectId }
    )
  } catch (err) {
    log.warn({ err, appId }, "backup notification dispatch failed")
  } finally {
    redis.disconnect()
  }
}

export async function runScheduledBackups(
  db: Db,
  now = new Date()
): Promise<{ queued: number; skipped: number }> {
  let queued = 0
  let skipped = 0
  const configs = await db
    .select({ config: backup_configs, db: databases })
    .from(backup_configs)
    .innerJoin(databases, eq(backup_configs.database_id, databases.id))
    .where(
      and(eq(backup_configs.enabled, true), eq(databases.status, "running"))
    )
  for (const { config, db: database } of configs) {
    try {
      const result = await runScheduledBackupConfig(
        db,
        "database",
        config.id,
        now,
        (tx, due) => runBackupOnce(tx, database.id, due)
      )
      if (result) {
        queued++
        await notifyBackup(
          db,
          result,
          database.id,
          database.name,
          database.project_id
        )
      } else skipped++
    } catch (err) {
      log.error(
        { err, configId: config.id },
        "scheduled database backup interrupted; occurrence remains due"
      )
    }
  }
  const volumeConfigs = await db
    .select({ config: volume_backup_configs, app: apps })
    .from(volume_backup_configs)
    .innerJoin(apps, eq(volume_backup_configs.app_id, apps.id))
    .where(eq(volume_backup_configs.enabled, true))
  for (const { config, app } of volumeConfigs) {
    try {
      const result = await runScheduledBackupConfig(
        db,
        "volume",
        config.id,
        now,
        (tx, due) => runVolumeBackupOnce(tx, app.id, config.volume_id, due)
      )
      if (result) {
        queued++
        await notifyBackup(
          db,
          result,
          app.id,
          `${app.name}:${config.volume_id}`,
          app.project_id
        )
      } else skipped++
    } catch (err) {
      log.error(
        { err, configId: config.id },
        "scheduled volume backup interrupted; occurrence remains due"
      )
    }
  }
  return { queued, skipped }
}

export function startBackupDatabasesCron(db: Db): void {
  stopBackupDatabasesCron()
  let running = false
  async function tick() {
    if (running) return
    running = true
    try {
      await runScheduledBackups(db)
    } catch (err) {
      log.error({ err }, "backup-databases cron tick error")
    } finally {
      running = false
    }
  }
  void tick()
  interval = setInterval(() => void tick(), 30_000)
}

export function stopBackupDatabasesCron(): void {
  if (interval !== null) clearInterval(interval)
  interval = null
}
