// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import { z } from "zod"
import { and, eq, desc, isNotNull, sql } from "drizzle-orm"
import {
  apps,
  app_volumes,
  databases,
  backup_configs,
  backups,
  volume_backup_configs,
  volume_backups,
  audit_log,
  projects,
  memberships,
  secrets,
  storage_destinations,
} from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { nanoid } from "nanoid"
import { getAppForUser } from "@ploydok/db/queries"
import { S3EndpointSchema, tokenHasScope } from "@ploydok/shared"
import { requireTotpVerified } from "../auth/second-factor"
import { runBackupOnce } from "../databases/backup"
import { runVolumeBackupOnce } from "../backups/volume"
import { runRestore } from "../databases/restore"
import { childLogger } from "../logger"
import type { AuthUser } from "../auth/middleware"
import { requireAnyScope, requireScope } from "../auth/require-scope"
import {
  createBackupS3Probe,
  deleteBackupArtifact,
  inspectBackupArtifact,
  resolveBackupDestination,
} from "../backups/storage"
import type {
  BackupArtifactMetadata,
  BackupS3Probe,
  S3BackedConfig,
} from "../backups/storage"

const log = childLogger("backups.routes")
const INVENTORY_PROBE_CONCURRENCY = 8
const INVENTORY_PROBE_TIMEOUT_MS = 5_000
const INVENTORY_PROBE_CACHE_TTL_MS = 60_000
const INVENTORY_PROBE_CACHE_MAX_ENTRIES = 2_048

type InventoryProbeResult = {
  artifact: BackupArtifactMetadata | null
  probeError: "unreachable" | null
}

type CachedInventoryProbe = {
  configId: string | null
  fingerprint: string
  expiresAt: number
  result: InventoryProbeResult
}

const inventoryProbeCache = new Map<string, CachedInventoryProbe>()

function invalidateInventoryProbeCache(options: {
  backupId?: string | undefined
  configId?: string | undefined
}): void {
  if (options.backupId) inventoryProbeCache.delete(options.backupId)
  if (options.configId) {
    for (const [backupId, entry] of inventoryProbeCache) {
      if (entry.configId === options.configId) inventoryProbeCache.delete(backupId)
    }
  }
}

function fingerprintInventoryProbe(
  location: string,
  config: (S3BackedConfig & { id?: string }) | null
): string {
  return [
    location,
    config?.id ?? "",
    config?.destination_id ?? "",
    config?.destination_updated_at?.toISOString() ?? "",
    config?.s3_endpoint ?? "",
    config?.s3_bucket ?? "",
    config?.s3_region ?? "",
    config?.s3_credentials_secret_id ?? "",
  ].join("\u0000")
}

function readCachedInventoryProbe(
  backupId: string,
  configId: string | null,
  fingerprint: string,
  now = Date.now()
): InventoryProbeResult | undefined {
  const cached = inventoryProbeCache.get(backupId)
  if (!cached || cached.expiresAt <= now || cached.fingerprint !== fingerprint) {
    if (cached) inventoryProbeCache.delete(backupId)
    return undefined
  }
  // Refresh insertion order to keep frequently used entries in the bounded LRU.
  inventoryProbeCache.delete(backupId)
  inventoryProbeCache.set(backupId, cached)
  return cached.configId === configId ? cached.result : undefined
}

function writeCachedInventoryProbe(
  backupId: string,
  configId: string | null,
  fingerprint: string,
  result: InventoryProbeResult,
  now = Date.now()
): void {
  inventoryProbeCache.delete(backupId)
  inventoryProbeCache.set(backupId, {
    configId,
    fingerprint,
    expiresAt: now + INVENTORY_PROBE_CACHE_TTL_MS,
    result,
  })
  while (inventoryProbeCache.size > INVENTORY_PROBE_CACHE_MAX_ENTRIES) {
    const oldest = inventoryProbeCache.keys().next().value
    if (!oldest) break
    inventoryProbeCache.delete(oldest)
  }
}

type AppEnv = { Variables: { user?: AuthUser } }

function getUser(c: { get: (k: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

async function lockBackupConfig(tx: Db, kind: "database" | "volume", configId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`backup:${kind}:${configId}`}, 0))`
  )
}

function param(
  c: { req: { param: (key: string) => string | undefined } },
  key: string
): string {
  const value = c.req.param(key)
  if (!value) throw new Error(`Missing route parameter: ${key}`)
  return value
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const BackupConfigBody = z.object({
  destinationId: z.string().min(1).nullable().optional(),
  destinationKind: z.enum(["s3", "local"]).optional(),
  s3Endpoint: S3EndpointSchema.optional(),
  s3Bucket: z.string().optional(),
  s3Prefix: z.string().optional(),
  s3Region: z.string().optional(),
  s3CredentialsSecretId: z.string().optional(),
  scheduleCron: z.string().min(9).max(100).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  ageRecipientPublicKey: z.string().max(200).optional().nullable(),
  enabled: z.boolean().optional(),
})

const RestoreBody = z.object({
  backupId: z.string().min(1),
  ageIdentity: z.string().optional(),
  confirm: z.string().min(1),
})

type InlineDestinationConfig = {
  destination_id: string | null
  destination_kind: "s3" | "local"
  s3_endpoint: string | null
  s3_bucket: string | null
  s3_region: string | null
  s3_credentials_secret_id: string | null
}

function isDestinationChangeRequested(
  existing: InlineDestinationConfig,
  data: z.infer<typeof BackupConfigBody>
): boolean {
  const existingDestinationId = existing.destination_id ?? null
  if (data.destinationId !== undefined && data.destinationId !== existingDestinationId) {
    return true
  }
  if (existingDestinationId) return false

  const inlineFieldsChanged =
    (data.destinationKind !== undefined &&
      data.destinationKind !== existing.destination_kind) ||
    (data.s3Endpoint !== undefined && data.s3Endpoint !== (existing.s3_endpoint ?? undefined)) ||
    (data.s3Bucket !== undefined && data.s3Bucket !== (existing.s3_bucket ?? undefined)) ||
    (data.s3Region !== undefined && data.s3Region !== (existing.s3_region ?? undefined)) ||
    (data.s3CredentialsSecretId !== undefined &&
      data.s3CredentialsSecretId !==
        (existing.s3_credentials_secret_id ?? undefined))

  if (data.destinationId === null) {
    return (
      existing.destination_kind !== "local" ||
      existing.s3_endpoint !== null ||
      existing.s3_bucket !== null ||
      existing.s3_region !== null ||
      existing.s3_credentials_secret_id !== null ||
      inlineFieldsChanged
    )
  }
  return inlineFieldsChanged
}

// ---------------------------------------------------------------------------
// Ownership helper
// ---------------------------------------------------------------------------

async function getDbForUser(db: Db, dbId: string, userId: string) {
  const rows = await db
    .select({ db: databases })
    .from(databases)
    .innerJoin(projects, eq(databases.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        isNotNull(memberships.accepted_at)
      )
    )
    .where(eq(databases.id, dbId))
    .limit(1)
  return rows[0]?.db ?? null
}

async function getDestinationForOrg(
  db: Db,
  destinationId: string,
  orgId: string
) {
  const rows = await db
    .select()
    .from(storage_destinations)
    .where(
      and(
        eq(storage_destinations.id, destinationId),
        eq(storage_destinations.org_id, orgId)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

async function legacySecretBelongsToOrg(
  db: Db,
  secretId: string,
  orgId: string
): Promise<boolean> {
  const rows = await db
    .select({ projectId: secrets.project_id })
    .from(secrets)
    .where(eq(secrets.id, secretId))
    .limit(1)
  return rows[0]?.projectId === orgId
}

async function getAppVolumeForUser(
  db: Db,
  appId: string,
  volumeId: string,
  userId: string
) {
  const app = await getAppForUser(db, appId, userId)
  if (!app) return null

  const rows = await db
    .select()
    .from(app_volumes)
    .where(and(eq(app_volumes.app_id, appId), eq(app_volumes.id, volumeId)))
    .limit(1)

  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBackupsRouter(db: Db): Hono<any, any, any> {
  const router = new Hono<AppEnv>()
  const totpMiddleware = requireTotpVerified(db)
  const appBackupsRead = requireScope("apps:read")
  const appBackupsWrite = requireScope("apps:write")
  const databaseBackupsRead = requireScope("databases:read")
  const databaseBackupsWrite = requireScope("databases:write")
  const deleteBackupScope = requireAnyScope(["apps:write", "databases:write"])
  const inventoryRead = requireAnyScope(["apps:read", "databases:read"])

  // GET /databases/:id/backups
  router.get("/databases/:id/backups", databaseBackupsRead, async (c) => {
    const user = getUser(c)
    const dbId = param(c, "id")

    const dbRow = await getDbForUser(db, dbId, user.id)
    if (!dbRow)
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )

    const rows = await db
      .select()
      .from(backups)
      .where(eq(backups.database_id, dbId))
      .orderBy(desc(backups.started_at))
      .limit(50)

    return c.json({ backups: rows.map(serializeBackup) })
  })

  // GET /apps/:appId/volumes/:volumeId/backups
  router.get("/apps/:appId/volumes/:volumeId/backups", appBackupsRead, async (c) => {
    const user = getUser(c)
    const appId = param(c, "appId")
    const volumeId = param(c, "volumeId")

    const volume = await getAppVolumeForUser(db, appId, volumeId, user.id)
    if (!volume) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App volume not found" } },
        404
      )
    }

    const rows = await db
      .select()
      .from(volume_backups)
      .where(
        and(
          eq(volume_backups.app_id, appId),
          eq(volume_backups.volume_id, volumeId)
        )
      )
      .orderBy(desc(volume_backups.started_at))
      .limit(50)

    return c.json({
      backups: rows.map((row) => serializeVolumeBackup(row, volume.app_id)),
    })
  })

  // GET /databases/:id/backup-config
  router.get("/databases/:id/backup-config", databaseBackupsRead, async (c) => {
    const user = getUser(c)
    const dbId = param(c, "id")

    const dbRow = await getDbForUser(db, dbId, user.id)
    if (!dbRow)
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )

    const configRows = await db
      .select()
      .from(backup_configs)
      .where(eq(backup_configs.database_id, dbId))
      .limit(1)

    if (!configRows[0]) {
      return c.json({ config: null })
    }
    return c.json({ config: serializeConfig(configRows[0]) })
  })

  // GET /apps/:appId/volumes/:volumeId/backup-config
  router.get(
    "/apps/:appId/volumes/:volumeId/backup-config",
    appBackupsRead,
    async (c) => {
      const user = getUser(c)
      const appId = param(c, "appId")
      const volumeId = param(c, "volumeId")

      const volume = await getAppVolumeForUser(db, appId, volumeId, user.id)
      if (!volume) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "App volume not found" } },
          404
        )
      }

      const configRows = await db
        .select()
        .from(volume_backup_configs)
        .where(
          and(
            eq(volume_backup_configs.app_id, appId),
            eq(volume_backup_configs.volume_id, volumeId)
          )
        )
        .limit(1)

      if (!configRows[0]) {
        return c.json({ config: null })
      }
      return c.json({ config: serializeVolumeConfig(configRows[0]!) })
    }
  )

  // GET /backups/inventory
  //
  // Inventory is intentionally destination-backed. A successful database row
  // can outlive its local file or S3 object, so only artifacts confirmed by a
  // stat/HEAD request are returned.
  router.get("/backups/inventory", inventoryRead, async (c) => {
    const user = getUser(c)
    const now = new Date()
    const kind = c.req.query("kind")
    const resourceId = c.req.query("resourceId")
    const appId = c.req.query("appId")
    if (kind && kind !== "database" && kind !== "volume") {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid backup kind" } },
        400
      )
    }
    const requestedLimit = Number(c.req.query("limit") ?? "200")
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 200)
        : 200
    const canReadDatabases =
      !user.token_scopes || tokenHasScope(user.token_scopes, "databases:read")
    const canReadVolumes =
      !user.token_scopes || tokenHasScope(user.token_scopes, "apps:read")

    const entries: BackupInventoryEntry[] = []
    const s3ProbeByConfig = new Map<string, Promise<BackupS3Probe>>()

    if (canReadDatabases && kind !== "volume" && !appId) {
      const rows = await db
        .select({
          backup: backups,
          database: databases,
          config: backup_configs,
          project: projects,
        })
        .from(backups)
        .innerJoin(databases, eq(backups.database_id, databases.id))
        .leftJoin(backup_configs, eq(backups.config_id, backup_configs.id))
        .innerJoin(projects, eq(databases.project_id, projects.id))
        .innerJoin(
          memberships,
          and(
            eq(memberships.org_id, projects.id),
            eq(memberships.user_id, user.id),
            isNotNull(memberships.accepted_at)
          )
        )
        .where(
          and(
            eq(backups.status, "succeeded"),
            resourceId ? eq(backups.database_id, resourceId) : undefined
          )
        )
        .orderBy(desc(backups.started_at), desc(backups.id))
        .limit(limit)

      const databaseEntries = await mapWithConcurrency<
        (typeof rows)[number],
        BackupInventoryEntry
      >(rows, INVENTORY_PROBE_CONCURRENCY, async (row) => {
        const probe = await inspectInventoryArtifact(
          db,
          row.backup.id,
          row.backup.location,
          row.config,
          s3ProbeByConfig
        )
        if (probe.probeError) {
          return {
            ...baseInventoryEntry(row),
            present: null,
            probeError: probe.probeError,
            sizeBytes: null,
            ageSeconds: null,
            artifactModifiedAt: null,
          }
        }
        if (!probe.artifact) {
          return {
            ...baseInventoryEntry(row),
            present: false,
            sizeBytes: null,
            ageSeconds: null,
            artifactModifiedAt: null,
          }
        }
        const artifact = probe.artifact

        return {
          ...baseInventoryEntry(row),
          present: true as const,
          sizeBytes: artifact.sizeBytes,
          ageSeconds: backupSnapshotAgeSeconds(
            now,
            row.backup.started_at,
            artifact.lastModifiedAt
          ),
          artifactModifiedAt: artifact.lastModifiedAt.toISOString(),
        }
      })
      entries.push(...databaseEntries)
    }

    if (canReadVolumes && kind !== "database") {
      const rows = await db
        .select({
          backup: volume_backups,
          app: apps,
          volume: app_volumes,
          config: volume_backup_configs,
          project: projects,
        })
        .from(volume_backups)
        .innerJoin(apps, eq(volume_backups.app_id, apps.id))
        .innerJoin(
          app_volumes,
          and(
            eq(volume_backups.volume_id, app_volumes.id),
            eq(app_volumes.app_id, apps.id)
          )
        )
        .leftJoin(
          volume_backup_configs,
          eq(volume_backups.config_id, volume_backup_configs.id)
        )
        .innerJoin(projects, eq(apps.project_id, projects.id))
        .innerJoin(
          memberships,
          and(
            eq(memberships.org_id, projects.id),
            eq(memberships.user_id, user.id),
            isNotNull(memberships.accepted_at)
          )
        )
        .where(
          and(
            eq(volume_backups.status, "succeeded"),
            resourceId ? eq(volume_backups.volume_id, resourceId) : undefined,
            appId ? eq(volume_backups.app_id, appId) : undefined
          )
        )
        .orderBy(desc(volume_backups.started_at), desc(volume_backups.id))
        .limit(limit)

      const volumeEntries = await mapWithConcurrency<
        (typeof rows)[number],
        BackupInventoryEntry
      >(rows, INVENTORY_PROBE_CONCURRENCY, async (row) => {
        const probe = await inspectInventoryArtifact(
          db,
          row.backup.id,
          row.backup.location,
          row.config,
          s3ProbeByConfig
        )
        if (probe.probeError) {
          return {
            ...baseInventoryEntry(row),
            present: null,
            probeError: probe.probeError,
            sizeBytes: null,
            ageSeconds: null,
            artifactModifiedAt: null,
          }
        }
        if (!probe.artifact) {
          return {
            ...baseInventoryEntry(row),
            present: false,
            sizeBytes: null,
            ageSeconds: null,
            artifactModifiedAt: null,
          }
        }
        const artifact = probe.artifact

        return {
          ...baseInventoryEntry(row),
          present: true as const,
          sizeBytes: artifact.sizeBytes,
          ageSeconds: backupSnapshotAgeSeconds(
            now,
            row.backup.started_at,
            artifact.lastModifiedAt
          ),
          artifactModifiedAt: artifact.lastModifiedAt.toISOString(),
        }
      })
      entries.push(...volumeEntries)
    }

    entries.sort((a, b) => {
      const newestFirst =
        Date.parse(b.artifactModifiedAt ?? "") -
        Date.parse(a.artifactModifiedAt ?? "")
      return newestFirst || b.id.localeCompare(a.id)
    })

    return c.json({
      generatedAt: now.toISOString(),
      backups: entries.slice(0, limit),
    })
  })

  // PUT /databases/:id/backup-config
  router.put("/databases/:id/backup-config", databaseBackupsWrite, async (c) => {
    const user = getUser(c)
    const dbId = param(c, "id")

    const dbRow = await getDbForUser(db, dbId, user.id)
    if (!dbRow)
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )

    const body = await c.req.json().catch(() => null)
    const parsed = BackupConfigBody.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        400
      )
    }

    const data = parsed.data
    const destination = data.destinationId
      ? await getDestinationForOrg(db, data.destinationId, dbRow.project_id)
      : null
    if (data.destinationId && !destination) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Storage destination not found" } },
        404
      )
    }
    if (
      !destination &&
      data.s3CredentialsSecretId &&
      !(await legacySecretBelongsToOrg(db, data.s3CredentialsSecretId, dbRow.project_id))
    ) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Storage credentials not found" } },
        404
      )
    }
    const existing = await db
      .select()
      .from(backup_configs)
      .where(eq(backup_configs.database_id, dbId))
      .limit(1)

    const hasInlineDestinationFields = [
      data.destinationKind,
      data.s3Endpoint,
      data.s3Bucket,
      data.s3Region,
      data.s3CredentialsSecretId,
    ].some((value) => value !== undefined)

    const detachDestination = data.destinationId === null
    const linkedDestinationFields = destination
      ? {
          destination_id: destination.id,
          destination_kind: destination.kind,
          s3_endpoint: null,
          s3_bucket: null,
          s3_region: null,
          s3_credentials_secret_id: null,
        }
      : detachDestination
        ? {
            destination_id: null,
            destination_kind: "local" as const,
            s3_endpoint: null,
            s3_bucket: null,
            s3_region: null,
            s3_credentials_secret_id: null,
          }
      : {}
    const updateFields = {
      ...linkedDestinationFields,
      ...(data.destinationId === undefined && data.destinationKind !== undefined && {
        destination_kind: data.destinationKind,
      }),
      ...(data.destinationId === undefined && data.s3Endpoint !== undefined && {
        s3_endpoint: data.s3Endpoint,
      }),
      ...(data.destinationId === undefined && data.s3Bucket !== undefined && {
        s3_bucket: data.s3Bucket,
      }),
      ...(data.s3Prefix !== undefined && { s3_prefix: data.s3Prefix }),
      ...(data.destinationId === undefined && data.s3Region !== undefined && {
        s3_region: data.s3Region,
      }),
      ...(data.destinationId === undefined && data.s3CredentialsSecretId !== undefined && {
        s3_credentials_secret_id: data.s3CredentialsSecretId,
      }),
      ...(data.scheduleCron !== undefined && {
        schedule_cron: data.scheduleCron,
      }),
      ...(data.retentionDays !== undefined && {
        retention_days: data.retentionDays,
      }),
      ...(data.ageRecipientPublicKey !== undefined && {
        age_recipient_public_key: data.ageRecipientPublicKey,
      }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
    }

    if (
      existing[0] &&
      (data.destinationId !== undefined || hasInlineDestinationFields)
    ) {
      const mutation = await db.transaction(async (tx) => {
        const transactionDb = tx as unknown as Db
        await lockBackupConfig(transactionDb, "database", existing[0]!.id)

        const lockedRows = await transactionDb
          .select()
          .from(backup_configs)
          .where(eq(backup_configs.id, existing[0]!.id))
          .for("update")
          .limit(1)
        const locked = lockedRows[0]
        if (!locked) return { kind: "missing" as const }

        if (locked.destination_id && hasInlineDestinationFields) {
          return { kind: "destination_required" as const }
        }

        const stillChangingDestination = isDestinationChangeRequested(locked, data)
        if (stillChangingDestination) {
          const liveBackups = await transactionDb
            .select({ id: backups.id })
            .from(backups)
            .where(eq(backups.config_id, locked.id))
            .limit(1)
          if (liveBackups[0]) return { kind: "in_use" as const }
        }

        await transactionDb
          .update(backup_configs)
          .set(updateFields)
          .where(eq(backup_configs.id, locked.id))
        const updated = await transactionDb
          .select()
          .from(backup_configs)
          .where(eq(backup_configs.id, locked.id))
          .limit(1)
        return { kind: "updated" as const, config: updated[0] }
      })

      if (mutation.kind === "in_use") {
        return c.json(
          {
            error: {
              code: "BACKUP_CONFIG_IN_USE",
              message:
                "Cannot change the storage destination while backups still reference this configuration",
            },
          },
          409
        )
      }
      if (mutation.kind === "destination_required") {
        return c.json(
          {
            error: {
              code: "DESTINATION_REQUIRED",
              message: "Select a storage destination instead of editing inline destination fields",
            },
          },
          400
        )
      }
      if (mutation.kind === "missing" || !mutation.config) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Backup configuration not found" } },
          404
        )
      }
      invalidateInventoryProbeCache({ configId: mutation.config.id })
      return c.json({ config: serializeConfig(mutation.config) })
    }

    if (existing[0]) {
      await db
        .update(backup_configs)
        .set(updateFields)
        .where(eq(backup_configs.id, existing[0].id))
      invalidateInventoryProbeCache({ configId: existing[0].id })
      const updated = await db
        .select()
        .from(backup_configs)
        .where(eq(backup_configs.id, existing[0].id))
        .limit(1)
      return c.json({ config: serializeConfig(updated[0]!) })
    }

    // Create new config
    const id = nanoid()
    await db.insert(backup_configs).values({
      id,
      database_id: dbId,
      destination_id: destination?.id ?? null,
      destination_kind: destination?.kind ?? data.destinationKind ?? "local",
      s3_endpoint: destination ? null : data.s3Endpoint,
      s3_bucket: destination ? null : data.s3Bucket,
      s3_prefix: data.s3Prefix,
      s3_region: destination ? null : data.s3Region,
      s3_credentials_secret_id: destination ? null : data.s3CredentialsSecretId,
      schedule_cron: data.scheduleCron ?? "0 3 * * *",
      retention_days: data.retentionDays ?? 7,
      age_recipient_public_key: data.ageRecipientPublicKey ?? null,
      enabled: data.enabled ?? true,
    })
    const created = await db
      .select()
      .from(backup_configs)
      .where(eq(backup_configs.id, id))
      .limit(1)
    return c.json({ config: serializeConfig(created[0]!) }, 201)
  })

  // PUT /apps/:appId/volumes/:volumeId/backup-config
  router.put(
    "/apps/:appId/volumes/:volumeId/backup-config",
    appBackupsWrite,
    async (c) => {
      const user = getUser(c)
      const appId = param(c, "appId")
      const volumeId = param(c, "volumeId")

      const volume = await getAppVolumeForUser(db, appId, volumeId, user.id)
      if (!volume) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "App volume not found" } },
          404
        )
      }

      const body = await c.req.json().catch(() => null)
      const parsed = BackupConfigBody.safeParse(body)
      if (!parsed.success) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
          400
        )
      }

      const data = parsed.data
      const appProjectRows = await db
        .select({ projectId: apps.project_id })
        .from(apps)
        .where(eq(apps.id, appId))
        .limit(1)
      const appProjectId = appProjectRows[0]?.projectId
      if (!appProjectId) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "App not found" } },
          404
        )
      }
      const destination = data.destinationId
        ? await getDestinationForOrg(db, data.destinationId, appProjectId)
        : null
      if (data.destinationId && !destination) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Storage destination not found" } },
          404
        )
      }
      if (
        !destination &&
        data.s3CredentialsSecretId &&
        !(await legacySecretBelongsToOrg(db, data.s3CredentialsSecretId, appProjectId))
      ) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Storage credentials not found" } },
          404
        )
      }
      const existing = await db
        .select()
        .from(volume_backup_configs)
        .where(
          and(
            eq(volume_backup_configs.app_id, appId),
            eq(volume_backup_configs.volume_id, volumeId)
          )
        )
        .limit(1)

      const hasInlineDestinationFields = [
        data.destinationKind,
        data.s3Endpoint,
        data.s3Bucket,
        data.s3Region,
        data.s3CredentialsSecretId,
      ].some((value) => value !== undefined)

      const detachDestination = data.destinationId === null
      const linkedDestinationFields = destination
        ? {
            destination_id: destination.id,
            destination_kind: destination.kind,
            s3_endpoint: null,
            s3_bucket: null,
            s3_region: null,
            s3_credentials_secret_id: null,
          }
        : detachDestination
          ? {
              destination_id: null,
              destination_kind: "local" as const,
              s3_endpoint: null,
              s3_bucket: null,
              s3_region: null,
              s3_credentials_secret_id: null,
            }
        : {}
      const updateFields = {
        ...linkedDestinationFields,
        ...(data.destinationId === undefined && data.destinationKind !== undefined && {
          destination_kind: data.destinationKind,
        }),
        ...(data.destinationId === undefined && data.s3Endpoint !== undefined && {
          s3_endpoint: data.s3Endpoint,
        }),
        ...(data.destinationId === undefined && data.s3Bucket !== undefined && {
          s3_bucket: data.s3Bucket,
        }),
        ...(data.s3Prefix !== undefined && { s3_prefix: data.s3Prefix }),
        ...(data.destinationId === undefined && data.s3Region !== undefined && {
          s3_region: data.s3Region,
        }),
        ...(data.destinationId === undefined && data.s3CredentialsSecretId !== undefined && {
          s3_credentials_secret_id: data.s3CredentialsSecretId,
        }),
        ...(data.scheduleCron !== undefined && {
          schedule_cron: data.scheduleCron,
        }),
        ...(data.retentionDays !== undefined && {
          retention_days: data.retentionDays,
        }),
        ...(data.ageRecipientPublicKey !== undefined && {
          age_recipient_public_key: data.ageRecipientPublicKey,
        }),
        ...(data.enabled !== undefined && { enabled: data.enabled }),
      }

      if (
        existing[0] &&
        (data.destinationId !== undefined || hasInlineDestinationFields)
      ) {
        const mutation = await db.transaction(async (tx) => {
          const transactionDb = tx as unknown as Db
          await lockBackupConfig(transactionDb, "volume", existing[0]!.id)

          const lockedRows = await transactionDb
            .select()
            .from(volume_backup_configs)
            .where(eq(volume_backup_configs.id, existing[0]!.id))
            .for("update")
            .limit(1)
          const locked = lockedRows[0]
          if (!locked) return { kind: "missing" as const }

          if (locked.destination_id && hasInlineDestinationFields) {
            return { kind: "destination_required" as const }
          }

          const stillChangingDestination = isDestinationChangeRequested(locked, data)
          if (stillChangingDestination) {
            const liveBackups = await transactionDb
              .select({ id: volume_backups.id })
              .from(volume_backups)
              .where(eq(volume_backups.config_id, locked.id))
              .limit(1)
            if (liveBackups[0]) return { kind: "in_use" as const }
          }

          await transactionDb
            .update(volume_backup_configs)
            .set(updateFields)
            .where(eq(volume_backup_configs.id, locked.id))
          const updated = await transactionDb
            .select()
            .from(volume_backup_configs)
            .where(eq(volume_backup_configs.id, locked.id))
            .limit(1)
          return { kind: "updated" as const, config: updated[0] }
        })

        if (mutation.kind === "in_use") {
          return c.json(
            {
              error: {
                code: "BACKUP_CONFIG_IN_USE",
                message:
                  "Cannot change the storage destination while backups still reference this configuration",
              },
            },
            409
          )
        }
        if (mutation.kind === "destination_required") {
          return c.json(
            {
              error: {
                code: "DESTINATION_REQUIRED",
                message: "Select a storage destination instead of editing inline destination fields",
              },
            },
            400
          )
        }
        if (mutation.kind === "missing" || !mutation.config) {
          return c.json(
            { error: { code: "NOT_FOUND", message: "Backup configuration not found" } },
            404
          )
        }
        invalidateInventoryProbeCache({ configId: mutation.config.id })
        return c.json({ config: serializeVolumeConfig(mutation.config) })
      }

      if (existing[0]) {
        await db
          .update(volume_backup_configs)
          .set(updateFields)
          .where(eq(volume_backup_configs.id, existing[0].id))
        invalidateInventoryProbeCache({ configId: existing[0].id })
        const updated = await db
          .select()
          .from(volume_backup_configs)
          .where(eq(volume_backup_configs.id, existing[0].id))
          .limit(1)
        return c.json({ config: serializeVolumeConfig(updated[0]!) })
      }

      const id = nanoid()
      await db.insert(volume_backup_configs).values({
        id,
        app_id: appId,
        volume_id: volumeId,
        destination_id: destination?.id ?? null,
        destination_kind: destination?.kind ?? data.destinationKind ?? "local",
        s3_endpoint: destination ? null : data.s3Endpoint,
        s3_bucket: destination ? null : data.s3Bucket,
        s3_prefix: data.s3Prefix,
        s3_region: destination ? null : data.s3Region,
        s3_credentials_secret_id: destination ? null : data.s3CredentialsSecretId,
        schedule_cron: data.scheduleCron ?? "0 3 * * *",
        retention_days: data.retentionDays ?? 7,
        age_recipient_public_key: data.ageRecipientPublicKey ?? null,
        enabled: data.enabled ?? true,
      })
      const created = await db
        .select()
        .from(volume_backup_configs)
        .where(eq(volume_backup_configs.id, id))
        .limit(1)
      return c.json({ config: serializeVolumeConfig(created[0]!) }, 201)
    }
  )

  // POST /databases/:id/backup-now
  router.post("/databases/:id/backup-now", databaseBackupsWrite, async (c) => {
    const user = getUser(c)
    const dbId = param(c, "id")

    const dbRow = await getDbForUser(db, dbId, user.id)
    if (!dbRow)
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )

    const enabledConfig = await db
      .select({ id: backup_configs.id })
      .from(backup_configs)
      .where(
        and(eq(backup_configs.database_id, dbId), eq(backup_configs.enabled, true))
      )
      .limit(1)
    if (!enabledConfig[0]) {
      return c.json(
        {
          error: {
            code: "BACKUP_NOT_CONFIGURED",
            message:
              "No enabled backup config for this database. Configure a destination (S3 or local) and enable backups before running one.",
          },
        },
        400
      )
    }

    log.info({ databaseId: dbId, userId: user.id }, "manual backup requested")

    const result = await runBackupOnce(db, dbId)
    if (result.status === "failed") {
      return c.json({ message: "Backup failed", ...result }, 500)
    }
    return c.json({ message: "Backup completed", ...result }, 200)
  })

  // POST /apps/:appId/volumes/:volumeId/backup-now
  router.post(
    "/apps/:appId/volumes/:volumeId/backup-now",
    appBackupsWrite,
    async (c) => {
      const user = getUser(c)
      const appId = param(c, "appId")
      const volumeId = param(c, "volumeId")

      const volume = await getAppVolumeForUser(db, appId, volumeId, user.id)
      if (!volume) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "App volume not found" } },
          404
        )
      }

      log.info(
        { appId, volumeId, volumeName: volume.name, userId: user.id },
        "manual volume backup requested"
      )

      const enabledConfig = await db
        .select({ id: volume_backup_configs.id })
        .from(volume_backup_configs)
        .where(
          and(
            eq(volume_backup_configs.app_id, appId),
            eq(volume_backup_configs.volume_id, volumeId),
            eq(volume_backup_configs.enabled, true)
          )
        )
        .limit(1)
      if (!enabledConfig[0]) {
        return c.json(
          {
            error: {
              code: "BACKUP_NOT_CONFIGURED",
              message:
                "No enabled backup config for this app volume. Configure a destination (S3 or local) and enable backups before running one.",
            },
          },
          400
        )
      }

      const result = await runVolumeBackupOnce(db, appId, volumeId)
      if (result.status === "failed") {
        return c.json({ message: "Backup failed", ...result }, 500)
      }
      return c.json({ message: "Backup completed", ...result }, 200)
    }
  )

  // POST /databases/:id/restore (TOTP required)
  router.post(
    "/databases/:id/restore",
    databaseBackupsWrite,
    totpMiddleware,
    async (c) => {
      const user = getUser(c)
      const dbId = param(c, "id")

      const dbRow = await getDbForUser(db, dbId, user.id)
      if (!dbRow)
        return c.json(
          { error: { code: "NOT_FOUND", message: "Database not found" } },
          404
        )

      const body = await c.req.json().catch(() => null)
      const parsed = RestoreBody.safeParse(body)
      if (!parsed.success) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
          400
        )
      }

      const { backupId, ageIdentity, confirm } = parsed.data

      // Challenge: user must type "restore <db_name>"
      const expected = `restore ${dbRow.name}`
      if (confirm !== expected) {
        return c.json(
          {
            error: {
              code: "CONFIRM_MISMATCH",
              message: `Type exactly "${expected}" to confirm restore`,
            },
          },
          400
        )
      }

      const backupRows = await db
        .select()
        .from(backups)
        .where(eq(backups.id, backupId))
        .limit(1)
      const backup = backupRows[0]
      if (!backup || backup.database_id !== dbId) {
        try {
          await db.insert(audit_log).values({
            user_id: user.id,
            action: "database.restore.rejected",
            target_type: "database",
            target_id: dbId,
            org_id: dbRow.project_id,
            metadata: JSON.stringify({
              backup_id: backupId,
              reason: "backup_database_mismatch",
            }),
            created_at: new Date(),
          })
        } catch (err) {
          log.warn(
            { err, databaseId: dbId, userId: user.id },
            "restore refusal audit failed"
          )
        }
        return c.json(
          { error: { code: "BACKUP_NOT_FOUND", message: "Backup not found" } },
          404
        )
      }

      log.warn(
        { databaseId: dbId, backupId, userId: user.id },
        "restore initiated"
      )

      try {
        const result = await runRestore(db, {
          backupId,
          databaseId: dbId,
          ...(ageIdentity ? { ageIdentity } : {}),
        })
        if (!result.ok) {
          return c.json(
            {
              error: {
                code: "RESTORE_FAILED",
                message: result.error ?? "restore failed",
              },
            },
            500
          )
        }
        return c.json({ ok: true })
      } catch (err) {
        log.error({ err, databaseId: dbId, backupId }, "restore error")
        return c.json(
          { error: { code: "RESTORE_FAILED", message: "Restore failed" } },
          500
        )
      }
    }
  )

  // DELETE /backups/:backupId
  router.delete("/backups/:backupId", deleteBackupScope, async (c) => {
    const user = getUser(c)
    const backupId = param(c, "backupId")

    // Load backup and verify ownership (owner-only for delete)
    const backupRows = await db
      .select({ backup: backups, db: databases })
      .from(backups)
      .innerJoin(databases, eq(backups.database_id, databases.id))
      .innerJoin(projects, eq(databases.project_id, projects.id))
      .innerJoin(
        memberships,
        and(
          eq(memberships.org_id, projects.id),
          eq(memberships.user_id, user.id),
          eq(memberships.role, "owner"),
          isNotNull(memberships.accepted_at)
        )
      )
      .where(eq(backups.id, backupId))
      .limit(1)

    const dbRow = backupRows[0]
    if (dbRow) {
      if (
        user.token_scopes &&
        !tokenHasScope(user.token_scopes, "databases:write")
      ) {
        log.warn(
          { backupId, databaseId: dbRow.db.id, userId: user.id },
          "backup delete denied: token missing database write scope"
        )
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Token missing required scope: databases:write",
            },
          },
          403
        )
      }

      invalidateInventoryProbeCache({
        backupId,
        configId: dbRow.backup.config_id ?? undefined,
      })
      try {
        let config = null
        if (dbRow.backup.config_id) {
          const configRows = await db
            .select()
            .from(backup_configs)
            .where(
              and(
                eq(backup_configs.id, dbRow.backup.config_id),
                eq(backup_configs.database_id, dbRow.db.id)
              )
            )
            .limit(1)
          config = configRows[0] ?? null
        }
        await deleteBackupArtifact(db, dbRow.backup.location, config)
      } catch (err) {
        log.warn({ err, backupId }, "failed to delete backup object (non-fatal)")
      }

      await db.delete(backups).where(eq(backups.id, backupId))
      return c.json({ ok: true })
    }

    const volumeRows = await db
      .select({ backup: volume_backups, app: apps, volume: app_volumes })
      .from(volume_backups)
      .innerJoin(apps, eq(volume_backups.app_id, apps.id))
      .innerJoin(
        app_volumes,
        and(
          eq(volume_backups.volume_id, app_volumes.id),
          eq(app_volumes.app_id, apps.id)
        )
      )
      .innerJoin(projects, eq(apps.project_id, projects.id))
      .innerJoin(
        memberships,
        and(
          eq(memberships.org_id, projects.id),
          eq(memberships.user_id, user.id),
          eq(memberships.role, "owner"),
          isNotNull(memberships.accepted_at)
        )
      )
      .where(eq(volume_backups.id, backupId))
      .limit(1)

    const volumeRow = volumeRows[0]
    if (!volumeRow) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Backup not found" } },
        404
      )
    }

    if (
      user.token_scopes &&
      !tokenHasScope(user.token_scopes, "apps:write")
    ) {
      log.warn(
        {
          backupId,
          appId: volumeRow.app.id,
          volumeId: volumeRow.volume.id,
          userId: user.id,
        },
        "backup delete denied: token missing app write scope"
      )
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Token missing required scope: apps:write",
          },
        },
        403
      )
    }

    invalidateInventoryProbeCache({
      backupId,
      configId: volumeRow.backup.config_id ?? undefined,
    })

    try {
      let config = null
      if (volumeRow.backup.config_id) {
        const configRows = await db
          .select()
          .from(volume_backup_configs)
          .where(
            and(
              eq(volume_backup_configs.id, volumeRow.backup.config_id),
              eq(volume_backup_configs.app_id, volumeRow.app.id),
              eq(volume_backup_configs.volume_id, volumeRow.volume.id)
            )
          )
          .limit(1)
        config = configRows[0] ?? null
      }
      await deleteBackupArtifact(db, volumeRow.backup.location, config)
    } catch (err) {
      log.warn(
        { err, backupId, appId: volumeRow.app.id, volumeId: volumeRow.volume.id },
        "failed to delete volume backup object (non-fatal)"
      )
    }

    await db.delete(volume_backups).where(eq(volume_backups.id, backupId))
    return c.json({ ok: true })
  })

  return router
}

// ---------------------------------------------------------------------------
// Serialisers
// ---------------------------------------------------------------------------

function serializeBackup(row: typeof backups.$inferSelect) {
  return {
    id: row.id,
    databaseId: row.database_id,
    configId: row.config_id,
    destinationKind: row.destination_kind,
    location: row.location,
    sizeBytes: row.size_bytes,
    ageEncrypted: row.age_encrypted,
    status: row.status,
    error: row.error,
    startedAt: row.started_at?.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
  }
}

function serializeConfig(row: typeof backup_configs.$inferSelect) {
  return {
    id: row.id,
    databaseId: row.database_id,
    destinationId: row.destination_id,
    destinationKind: row.destination_kind,
    s3Prefix: row.s3_prefix,
    scheduleCron: row.schedule_cron,
    retentionDays: row.retention_days,
    ageRecipientPublicKey: row.age_recipient_public_key,
    enabled: row.enabled,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at?.toISOString(),
  }
}

function serializeVolumeBackup(
  row: typeof volume_backups.$inferSelect,
  appId: string
) {
  return {
    id: row.id,
    appId,
    volumeId: row.volume_id,
    configId: row.config_id,
    destinationKind: row.destination_kind,
    location: row.location,
    sizeBytes: row.size_bytes,
    ageEncrypted: row.age_encrypted,
    status: row.status,
    error: row.error,
    startedAt: row.started_at?.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
  }
}

function serializeVolumeConfig(row: typeof volume_backup_configs.$inferSelect) {
  return {
    id: row.id,
    appId: row.app_id,
    volumeId: row.volume_id,
    destinationId: row.destination_id,
    destinationKind: row.destination_kind,
    s3Prefix: row.s3_prefix,
    scheduleCron: row.schedule_cron,
    retentionDays: row.retention_days,
    ageRecipientPublicKey: row.age_recipient_public_key,
    enabled: row.enabled,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at?.toISOString(),
  }
}

interface BackupInventoryEntry {
  id: string
  kind: "database" | "volume"
  resourceId: string
  resourceName: string
  projectId: string
  databaseId: string | null
  databaseName: string | null
  appId: string | null
  appName: string | null
  volumeId: string | null
  volumeName: string | null
  configId: string | null
  destinationKind: "s3" | "local" | null
  location: string
  present: true | false | null
  probeError?: "unreachable"
  sizeBytes: number | null
  ageSeconds: number | null
  artifactModifiedAt: string | null
  startedAt: string
  finishedAt: string | null
}

type InventoryRowBase = {
  backup: {
    id: string
    config_id: string | null
    destination_kind: "s3" | "local" | null
    location: string
    started_at: Date
    finished_at: Date | null
  }
  project: { id: string }
  database?: { id: string; name: string }
  app?: { id: string; name: string }
  volume?: { id: string; name: string }
}

function baseInventoryEntry(row: InventoryRowBase) {
  if (row.database) {
    return {
      id: row.backup.id,
      kind: "database" as const,
      resourceId: row.database.id,
      resourceName: row.database.name,
      projectId: row.project.id,
      databaseId: row.database.id,
      databaseName: row.database.name,
      appId: null,
      appName: null,
      volumeId: null,
      volumeName: null,
      configId: row.backup.config_id,
      destinationKind: row.backup.destination_kind,
      location: row.backup.location,
      startedAt: row.backup.started_at.toISOString(),
      finishedAt: row.backup.finished_at?.toISOString() ?? null,
    }
  }
  if (!row.app || !row.volume) {
    throw new Error("Backup inventory row is missing its resource")
  }
  return {
    id: row.backup.id,
    kind: "volume" as const,
    resourceId: row.volume.id,
    resourceName: `${row.app.name}:${row.volume.name}`,
    projectId: row.project.id,
    databaseId: null,
    databaseName: null,
    appId: row.app.id,
    appName: row.app.name,
    volumeId: row.volume.id,
    volumeName: row.volume.name,
    configId: row.backup.config_id,
    destinationKind: row.backup.destination_kind,
    location: row.backup.location,
    startedAt: row.backup.started_at.toISOString(),
    finishedAt: row.backup.finished_at?.toISOString() ?? null,
  }
}

async function inspectInventoryArtifact(
  db: Db,
  backupId: string,
  location: string,
  config: (S3BackedConfig & { id?: string }) | null,
  s3ProbeByConfig: Map<string, Promise<BackupS3Probe>>
): Promise<InventoryProbeResult> {
  const configId = config?.id ?? null
  const resolvedConfig = config
    ? await resolveBackupDestination(db, config)
    : null
  const resolvedWithId =
    resolvedConfig && config?.id
      ? { ...resolvedConfig, id: config.id }
      : resolvedConfig
  const fingerprint = fingerprintInventoryProbe(location, resolvedWithId)
  const cached = readCachedInventoryProbe(backupId, configId, fingerprint)
  if (cached) return cached

  let s3Probe: Promise<BackupS3Probe> | undefined
  if (location.startsWith("s3://") && resolvedWithId) {
    const key = configId ?? fingerprint
    s3Probe = s3ProbeByConfig.get(key)
    if (!s3Probe) {
      s3Probe = createBackupS3Probe(db, resolvedWithId)
      s3ProbeByConfig.set(key, s3Probe)
    }
  }

  let result: InventoryProbeResult
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const probeTask = (async () =>
      inspectBackupArtifact(db, location, resolvedWithId, await s3Probe)
    )()
    const artifact = await Promise.race([
      probeTask,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Backup artifact probe timed out")),
          INVENTORY_PROBE_TIMEOUT_MS
        )
      }),
    ])
    result = { artifact, probeError: null }
  } catch {
    // Provider errors may include destination URLs or secret metadata.
    result = { artifact: null, probeError: "unreachable" }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  writeCachedInventoryProbe(backupId, configId, fingerprint, result)
  return result
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await map(items[index]!)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  )
  return results
}

function backupSnapshotAgeSeconds(
  now: Date,
  startedAt: Date,
  artifactModifiedAt: Date
): number {
  const snapshotAge = Math.floor((now.getTime() - startedAt.getTime()) / 1_000)
  const artifactAge = Math.floor(
    (now.getTime() - artifactModifiedAt.getTime()) / 1_000
  )
  return Math.max(0, snapshotAge, artifactAge)
}
