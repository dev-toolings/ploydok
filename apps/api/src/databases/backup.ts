// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Core backup orchestration for managed databases.
 *
 * Flow:
 *  1. Load database + config rows.
 *  2. Insert a "running" backups row.
 *  3. Call agent DumpDatabase (server-streaming).
 *  4. Upload chunks to S3 or write to local filesystem.
 *  5. Update backups row to succeeded/failed.
 *  6. Delete backups older than retention_days.
 *  7. Update backup_configs.last_run_at + last_error.
 */
import path from "node:path"
import { Readable } from "node:stream"
import { nanoid } from "nanoid"
import { and, eq, lt, sql } from "drizzle-orm"
import { databases, backup_configs, backups } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"
import { env } from "../env"
import { isRemoteLocation } from "../storage/object-store"
import {
  buildBackupFilename,
  buildBackupLocation,
  deleteBackupArtifact,
  resolveBackupDestination,
  writeBackupStream,
} from "../backups/storage"

const log = childLogger("databases.backup")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupRunResult {
  backupId: string
  status: "succeeded" | "failed"
  sizeBytes: number
  location: string
}

type PreparedBackup = {
  database: typeof databases.$inferSelect
  config: typeof backup_configs.$inferSelect
  backupId: string
  startedAt: Date
  location: string
}

async function prepareBackup(
  db: Db,
  databaseId: string,
  scheduledAt?: Date
): Promise<PreparedBackup> {
  const dbRows = await db
    .select()
    .from(databases)
    .where(eq(databases.id, databaseId))
    .limit(1)
  const dbRow = dbRows[0]
  if (!dbRow) throw new Error(`Database not found: ${databaseId}`)
  if (!dbRow.container_id) throw new Error(`Database ${databaseId} has no container_id`)

  const selectedConfigRows = await db
    .select()
    .from(backup_configs)
    .where(and(eq(backup_configs.database_id, databaseId), eq(backup_configs.enabled, true)))
    .limit(1)
  const selectedConfig = selectedConfigRows[0]
  if (!selectedConfig) throw new Error(`No enabled backup config for database ${databaseId}`)

  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`backup:database:${selectedConfig.id}`}, 0))`
  )

  // Re-read after taking the lock so a concurrent destination update cannot
  // leave this row pointing at the configuration that was read before it.
  const configRows = await db
    .select()
    .from(backup_configs)
    .where(
      and(
        eq(backup_configs.id, selectedConfig.id),
        eq(backup_configs.enabled, true)
      )
    )
    .limit(1)
  const rawConfig = configRows[0]
  if (!rawConfig) throw new Error(`No enabled backup config for database ${databaseId}`)
  const config = (await resolveBackupDestination(
    db,
    rawConfig
  )) as typeof backup_configs.$inferSelect

  const backupId = nanoid()
  const startedAt = new Date()
  const ageEncrypted = Boolean(config.age_recipient_public_key)
  const filename = buildBackupFilename(scheduledAt ?? startedAt, "dump", ageEncrypted)
  const location = buildBackupLocation(
    config,
    `${config.s3_prefix ? `${config.s3_prefix.replace(/\/$/, "")}/` : ""}${databaseId}/${filename}`,
    () =>
      path.join(
        env.PLOYDOK_LOCAL_BACKUP_DIR,
        databaseId,
        filename
      )
  )

  await db.insert(backups).values({
    id: backupId,
    database_id: databaseId,
    config_id: config.id,
    destination_kind: config.destination_kind,
    location,
    age_encrypted: ageEncrypted,
    status: "running",
    started_at: startedAt,
  })

  return { database: dbRow, config, backupId, startedAt, location }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBackupOnce(db: Db, databaseId: string, scheduledAt?: Date): Promise<BackupRunResult> {
  const bkLog = log.child({ databaseId })

  const prepared = await db.transaction((tx) =>
    prepareBackup(tx as unknown as Db, databaseId, scheduledAt)
  )
  const { database: dbRow, config, backupId, location } = prepared
  if (!dbRow.container_id) {
    throw new Error(`Database ${databaseId} has no container_id`)
  }

  let sizeBytes = 0
  let error: string | undefined

  try {
    // 3. Stream dump from agent
    const agent = getSharedAgent()
    const dumpStream = agent.dumpDatabase({
      containerId: dbRow.container_id,
      kind: dbRow.kind,
      ageRecipient: config.age_recipient_public_key ?? "",
    })
    const source = Readable.from(
      (async function* () {
        for await (const chunk of dumpStream) {
          if (chunk.data.length > 0) {
            yield Buffer.from(chunk.data)
          }
        }
      })()
    )

    // 4. Upload or write
    const stored = await writeBackupStream(db, config, location, source)
    sizeBytes = stored.sizeBytes

    bkLog.info({ backupId, location, sizeBytes }, "backup completed")
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    bkLog.error({ backupId, err }, "backup failed")
  }

  // 5. Update backups row
  const status = error ? "failed" : "succeeded"
  await db
    .update(backups)
    .set({ status, error: error ?? null, size_bytes: sizeBytes, finished_at: new Date() })
    .where(eq(backups.id, backupId))

  // 6. Delete backups older than retention_days
  await purgeOldBackups(db, databaseId, config.id, config.retention_days, config)

  // 7. Update config last_run_at + last_error
  await db
    .update(backup_configs)
    .set({ last_run_at: new Date(), last_error: error ?? null })
    .where(eq(backup_configs.id, config.id))

  return { backupId, status, sizeBytes, location }
}

// ---------------------------------------------------------------------------
// Retention purge
// ---------------------------------------------------------------------------

async function purgeOldBackups(
  db: Db,
  databaseId: string,
  configId: string,
  retentionDays: number,
  config: typeof backup_configs.$inferSelect,
): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)

  const old = await db
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.database_id, databaseId),
        eq(backups.config_id, configId),
        lt(backups.started_at, cutoff),
      ),
    )

  for (const backup of old) {
    try {
      await deleteBackupArtifact(
        db,
        backup.location,
        isRemoteLocation(backup.location) ? config : null
      )
    } catch (err) {
      log.warn({ err, backupId: backup.id }, "failed to delete old backup object (non-fatal)")
    }

    await db.delete(backups).where(eq(backups.id, backup.id))
  }

  if (old.length > 0) {
    log.info({ databaseId, purged: old.length, cutoff }, "old backups purged")
  }
}
