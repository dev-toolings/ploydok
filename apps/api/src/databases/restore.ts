// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Database restore orchestration.
 *
 * Flow:
 *  1. Load backup row + database row.
 *  2. Download dump from S3 or read from local filesystem.
 *  3. Stream bytes to agent RestoreDatabase RPC.
 *  4. Return RestoreResult.
 *
 * Security: the age private key is provided by the user at restore-time,
 * never stored server-side.
 */
import { createReadStream } from "node:fs"
import { nanoid } from "nanoid"
import { eq } from "drizzle-orm"
import { databases, backups, backup_configs } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { getSharedAgent } from "../debug/singletons"
import { createS3Client, downloadStream } from "../storage/s3"
import { resolveBackupDestination, resolveS3Credentials } from "../backups/storage"
import { childLogger } from "../logger"
import type { RestoreChunk } from "@ploydok/agent-proto"

const log = childLogger("databases.restore")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  backupId: string
  /** age private key (X25519 identity) — pasted by user, never stored. Empty = dump not encrypted. */
  ageIdentity?: string
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runRestore(db: Db, opts: RestoreOptions): Promise<{ ok: boolean; error?: string }> {
  const { backupId, ageIdentity } = opts
  const restoreLog = log.child({ backupId })

  // 1. Load backup + database
  const backupRows = await db
    .select()
    .from(backups)
    .where(eq(backups.id, backupId))
    .limit(1)
  const backup = backupRows[0]
  if (!backup) throw new Error(`Backup not found: ${backupId}`)
  if (backup.status !== "succeeded") {
    throw new Error(`Cannot restore backup with status ${backup.status}`)
  }

  const dbRows = await db
    .select()
    .from(databases)
    .where(eq(databases.id, backup.database_id))
    .limit(1)
  const dbRow = dbRows[0]
  if (!dbRow) throw new Error(`Database not found: ${backup.database_id}`)
  if (!dbRow.container_id) throw new Error(`Database ${backup.database_id} has no container_id`)

  restoreLog.info({ databaseId: dbRow.id, location: backup.location, kind: dbRow.kind }, "restore started")

  // 2. Download backup stream
  let downloadReadable: import("node:stream").Readable

  if (backup.location.startsWith("s3://")) {
    const configRows = await db
      .select()
      .from(backup_configs)
      .where(eq(backup_configs.id, backup.config_id!))
      .limit(1)
    const rawConfig = configRows[0]
    if (!rawConfig) throw new Error(`Backup config not found for backup ${backupId}`)
    const config = await resolveBackupDestination(db, rawConfig)
    const creds = await resolveS3Credentials(db, config)

    const client = createS3Client({
      ...(config.s3_endpoint ? { endpoint: config.s3_endpoint } : {}),
      region: config.s3_region ?? "auto",
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    })
    const url = new URL(backup.location)
    const bucket = url.hostname
    const key = url.pathname.replace(/^\//, "")
    downloadReadable = await downloadStream(client, bucket, key)
  } else {
    downloadReadable = createReadStream(backup.location)
  }

  // 3. Build async iterable of RestoreChunks
  // ts-proto generates flat optional fields (no payload oneof wrapper)
  const headerChunk: RestoreChunk = {
    header: {
      containerId: dbRow.container_id,
      kind: dbRow.kind,
      ageIdentity: ageIdentity ?? "",
    },
  }

  async function* buildChunks(): AsyncIterable<RestoreChunk> {
    yield headerChunk

    for await (const data of downloadReadable) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array)
      yield { data: buf }
    }
  }

  // 4. Send to agent
  const agent = getSharedAgent()
  const result = await agent.restoreDatabase(buildChunks())

  if (!result.ok) {
    restoreLog.warn({ error: result.error }, "restore failed")
  } else {
    restoreLog.info("restore completed")
  }

  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
}
