// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import { nanoid } from "nanoid"
import { and, eq, lt, sql } from "drizzle-orm"
import {
  apps,
  app_volumes,
  volume_backup_configs,
  volume_backups,
} from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { childLogger } from "../logger"
import { env } from "../env"
import { isRemoteLocation } from "../storage/object-store"
import {
  buildBackupFilename,
  buildBackupLocation,
  deleteBackupArtifact,
  resolveBackupDestination,
  writeBackupStream,
} from "./storage"

const log = childLogger("backups.volume")

export interface VolumeBackupRunResult {
  backupId: string
  status: "succeeded" | "failed"
  sizeBytes: number
  location: string
}

type PreparedVolumeBackup = {
  volumeName: string
  config: typeof volume_backup_configs.$inferSelect
  backupId: string
  location: string
  startedAt: Date
}

interface ArchiveSource {
  stream: Readable
  completed: Promise<void>
  abort: () => void
}

async function prepareVolumeBackup(
  db: Db,
  appId: string,
  volumeId: string,
  scheduledAt?: Date
): Promise<PreparedVolumeBackup> {
  const volumeRows = await db
    .select({ app: apps, volume: app_volumes })
    .from(app_volumes)
    .innerJoin(apps, eq(app_volumes.app_id, apps.id))
    .where(and(eq(apps.id, appId), eq(app_volumes.id, volumeId)))
    .limit(1)
  const volumeRow = volumeRows[0]
  if (!volumeRow) {
    throw new Error(`App volume not found: ${appId}/${volumeId}`)
  }

  const selectedConfigRows = await db
    .select()
    .from(volume_backup_configs)
    .where(
      and(
        eq(volume_backup_configs.app_id, appId),
        eq(volume_backup_configs.volume_id, volumeId),
        eq(volume_backup_configs.enabled, true)
      )
    )
    .limit(1)
  const selectedConfig = selectedConfigRows[0]
  if (!selectedConfig) {
    throw new Error(
      `No enabled backup config for app volume ${appId}/${volumeId}`
    )
  }

  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`backup:volume:${selectedConfig.id}`}, 0))`
  )

  const configRows = await db
    .select()
    .from(volume_backup_configs)
    .where(
      and(
        eq(volume_backup_configs.id, selectedConfig.id),
        eq(volume_backup_configs.enabled, true)
      )
    )
    .limit(1)
  const rawConfig = configRows[0]
  if (!rawConfig) {
    throw new Error(
      `No enabled backup config for app volume ${appId}/${volumeId}`
    )
  }
  const config = (await resolveBackupDestination(
    db,
    rawConfig
  )) as typeof volume_backup_configs.$inferSelect

  const backupId = nanoid()
  const startedAt = new Date()
  const ageEncrypted = Boolean(config.age_recipient_public_key)
  const filename = buildBackupFilename(
    scheduledAt ?? startedAt,
    "tar",
    ageEncrypted
  )
  const location = buildBackupLocation(
    config,
    buildVolumeS3Key(config.s3_prefix, appId, volumeId, filename),
    () =>
      path.join(
        env.PLOYDOK_BUILD_DIR ?? "/tmp/ploydok-dev/builds",
        "..",
        "backups",
        "apps",
        appId,
        volumeId,
        filename
      )
  )

  await db.insert(volume_backups).values({
    id: backupId,
    app_id: appId,
    volume_id: volumeId,
    config_id: config.id,
    destination_kind: config.destination_kind,
    location,
    age_encrypted: ageEncrypted,
    status: "running",
    started_at: startedAt,
  })

  return {
    volumeName: volumeRow.volume.name,
    config,
    backupId,
    location,
    startedAt,
  }
}

interface WaitableChildProcess {
  stderr: NodeJS.ReadableStream | null
  on(event: string, listener: (...args: any[]) => void): unknown
}

export function getAppVolumeHostPath(appId: string, volumeId: string): string {
  const root =
    process.env.PLOYDOK_APP_VOLUMES_ROOT ?? "/var/lib/ploydok/app-volumes"
  return path.join(root, appId, volumeId)
}

export async function runVolumeBackupOnce(
  db: Db,
  appId: string,
  volumeId: string,
  scheduledAt?: Date
): Promise<VolumeBackupRunResult> {
  const prepared = await db.transaction((tx) =>
    prepareVolumeBackup(tx as unknown as Db, appId, volumeId, scheduledAt)
  )
  const { volumeName, config, backupId, location } = prepared
  const volumeLog = log.child({ appId, volumeId, backupId })

  let sizeBytes = 0
  let error: string | undefined

  try {
    const hostPath = getAppVolumeHostPath(appId, volumeId)
    const archive = await createVolumeArchiveSource(
      hostPath,
      config.age_recipient_public_key
    )

    try {
      const stored = await writeBackupStream(
        db,
        config,
        location,
        archive.stream
      )
      await archive.completed
      sizeBytes = stored.sizeBytes
      if (sizeBytes === 0 && !isRemoteLocation(location)) {
        sizeBytes = (await stat(location).catch(() => null))?.size ?? 0
      }
    } catch (err) {
      archive.abort()
      throw err
    }

    volumeLog.info(
      { location, sizeBytes, volumeName },
      "volume backup completed"
    )
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    volumeLog.error({ err }, "volume backup failed")
  }

  const status = error ? "failed" : "succeeded"
  await db
    .update(volume_backups)
    .set({
      status,
      error: error ?? null,
      size_bytes: sizeBytes,
      finished_at: new Date(),
    })
    .where(eq(volume_backups.id, backupId))

  await purgeOldVolumeBackups(
    db,
    appId,
    volumeId,
    config.id,
    config.retention_days,
    config
  )

  await db
    .update(volume_backup_configs)
    .set({ last_run_at: new Date(), last_error: error ?? null })
    .where(eq(volume_backup_configs.id, config.id))

  return { backupId, status, sizeBytes, location }
}

async function purgeOldVolumeBackups(
  db: Db,
  appId: string,
  volumeId: string,
  configId: string,
  retentionDays: number,
  config: typeof volume_backup_configs.$inferSelect
): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)

  const old = await db
    .select()
    .from(volume_backups)
    .where(
      and(
        eq(volume_backups.app_id, appId),
        eq(volume_backups.volume_id, volumeId),
        eq(volume_backups.config_id, configId),
        lt(volume_backups.started_at, cutoff)
      )
    )

  for (const backup of old) {
    try {
      await deleteBackupArtifact(
        db,
        backup.location,
        isRemoteLocation(backup.location) ? config : null
      )
    } catch (err) {
      log.warn(
        { err, backupId: backup.id, appId, volumeId },
        "failed to delete old volume backup object (non-fatal)"
      )
    }

    await db.delete(volume_backups).where(eq(volume_backups.id, backup.id))
  }
}

async function createVolumeArchiveSource(
  hostPath: string,
  ageRecipient: string | null
): Promise<ArchiveSource> {
  const info = await stat(hostPath).catch(() => null)
  if (!info?.isDirectory()) {
    throw new Error(`App volume path not found: ${hostPath}`)
  }

  const tarProc = spawn("tar", ["-cf", "-", "-C", hostPath, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  })

  if (!ageRecipient) {
    return {
      stream: tarProc.stdout,
      completed: waitForProcess(
        tarProc as unknown as WaitableChildProcess,
        "tar"
      ),
      abort: () => tarProc.kill("SIGTERM"),
    }
  }

  const ageProc = spawn("age", ["-r", ageRecipient], {
    stdio: ["pipe", "pipe", "pipe"],
  })

  tarProc.stdout.pipe(ageProc.stdin)
  tarProc.stdout.on("error", (err) => ageProc.stdin.destroy(err))

  return {
    stream: ageProc.stdout,
    completed: Promise.all([
      waitForProcess(tarProc as unknown as WaitableChildProcess, "tar"),
      waitForProcess(ageProc as unknown as WaitableChildProcess, "age"),
    ]).then(() => undefined),
    abort: () => {
      tarProc.kill("SIGTERM")
      ageProc.kill("SIGTERM")
    },
  }
}

function waitForProcess(
  child: WaitableChildProcess,
  label: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ""

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on("error", (err: Error) =>
      reject(new Error(`${label} spawn failed: ${String(err)}`))
    )
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolve()
        return
      }

      const detail = stderr.trim()
      reject(
        new Error(
          `${label} failed with ${signal ? `signal ${signal}` : `exit ${code}`}${
            detail ? `: ${detail}` : ""
          }`
        )
      )
    })
  })
}

function buildVolumeS3Key(
  prefix: string | null,
  appId: string,
  volumeId: string,
  filename: string
): string {
  const normalizedPrefix = prefix ? `${prefix.replace(/\/$/, "")}/` : ""
  return `${normalizedPrefix}${appId}/${volumeId}/${filename}`
}
