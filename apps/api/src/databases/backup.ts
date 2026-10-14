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
import { and, eq, lt } from "drizzle-orm"
import { databases, backup_configs, backups } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"
import { env } from "../env"
import {
  buildBackupFilename,
  deleteBackupArtifact,
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBackupOnce(db: Db, databaseId: string, scheduledAt?: Date): Promise<BackupRunResult> {
  const bkLog = log.child({ databaseId })

  // 1. Load database + backup_config
  const dbRows = await db
    .select()
    .from(databases)
    .where(eq(databases.id, databaseId))
    .limit(1)
  const dbRow = dbRows[0]
  if (!dbRow) throw new Error(`Database not found: ${databaseId}`)
  if (!dbRow.container_id) throw new Error(`Database ${databaseId} has no container_id`)

  const configRows = await db
    .select()
    .from(backup_configs)
    .where(and(eq(backup_configs.database_id, databaseId), eq(backup_configs.enabled, true)))
    .limit(1)
  const config = configRows[0]
  if (!config) throw new Error(`No enabled backup config for database ${databaseId}`)

  // 2. Insert backups row with status=running
  const backupId = nanoid()
  const startedAt = new Date()
  const ageEncrypted = Boolean(config.age_recipient_public_key)

  // Determine location
  const filename = buildBackupFilename(scheduledAt ?? startedAt, "dump", ageEncrypted)
  let location: string
  if (config.destination_kind === "s3") {
    const prefix = config.s3_prefix ? `${config.s3_prefix.replace(/\/$/, "")}/` : ""
    location = `s3://${config.s3_bucket}/${prefix}${databaseId}/${filename}`
  } else {
    location = path.join(env.PLOYDOK_BUILD_DIR ?? "/tmp/ploydok-dev/builds", "..", "backups", databaseId, filename)
  }

  await db.insert(backups).values({
    id: backupId,
    database_id: databaseId,
    config_id: config.id,
    destination_kind: config.destination_kind as "s3" | "local",
    location,
    age_encrypted: ageEncrypted,
    status: "running",
    started_at: startedAt,
  })

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
  await purgeOldBackups(db, databaseId, config.id, config.retention_days, config.destination_kind as "s3" | "local", config)

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
  kind: "s3" | "local",
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
      await deleteBackupArtifact(db, backup.location, kind === "s3" ? config : null)
    } catch (err) {
      log.warn({ err, backupId: backup.id }, "failed to delete old backup object (non-fatal)")
    }

    await db.delete(backups).where(eq(backups.id, backup.id))
  }

  if (old.length > 0) {
    log.info({ databaseId, purged: old.length, cutoff }, "old backups purged")
  }
}
