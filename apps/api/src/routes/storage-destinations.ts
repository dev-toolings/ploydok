// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Hono } from "hono"
import { and, eq, sql } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  secrets,
  storage_destinations,
  backup_configs,
  volume_backup_configs,
} from "@ploydok/db"
import type { Db } from "@ploydok/db"
import {
  CreateStorageDestinationSchema,
  detectStorageProvider,
  STORAGE_PROVIDERS,
  storageCredentialsMatchKind,
  StorageProviderIdSchema,
  UpdateStorageDestinationSchema,
  type StorageCredentialsInput,
} from "@ploydok/shared"
import type { AuthUser } from "../auth/middleware"
import { requireRole } from "../auth/require-role"
import { requireScope } from "../auth/require-scope"
import { encryptField } from "../github/app-credentials"
import { parseDestinationCredentials } from "../backups/storage"
import {
  classifyStorageError,
  openObjectStore,
  type StorageFailureReason,
} from "../storage/object-store"
import { env } from "../env"

type AppEnv = {
  Variables: {
    user?: AuthUser
    org_id?: string
    membership_role?: "owner" | "member"
  }
}

function getOrgId(c: {
  get: (key: string) => unknown
  req?: { param: (key: string) => string | undefined }
}): string {
  return (c.get("org_id") as string | undefined) ?? c.req?.param("orgSlug") ?? ""
}

function destinationSummary(
  row: typeof storage_destinations.$inferSelect,
  usageCount: number
) {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    kind: row.kind,
    provider: destinationProvider(row),
    endpoint: row.s3_endpoint,
    bucket: row.s3_bucket,
    region: row.s3_region,
    credentialsConfigured: Boolean(row.credentials_secret_id),
    usageCount,
    lastTestAt: row.last_test_at?.toISOString() ?? null,
    lastTestStatus: row.last_test_status,
    lastTestError: row.last_test_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function destinationProvider(row: typeof storage_destinations.$inferSelect) {
  const stored = StorageProviderIdSchema.safeParse(row.provider)
  return stored.success && STORAGE_PROVIDERS[stored.data].kind === row.kind
    ? stored.data
    : detectStorageProvider(row.kind, row.s3_endpoint)
}

async function usageCount(db: Db, destinationId: string): Promise<number> {
  const rows = await db
    .select({
      count: sql<number>`(
        (SELECT count(*) FROM backup_configs WHERE destination_id = ${destinationId}) +
        (SELECT count(*) FROM volume_backup_configs WHERE destination_id = ${destinationId})
      )`,
    })
    .from(storage_destinations)
    .where(eq(storage_destinations.id, destinationId))
    .limit(1)
  return Number(rows[0]?.count ?? 0)
}

async function usageCountsByDestination(
  db: Db,
  orgId: string
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      destinationId: storage_destinations.id,
      usageCount: sql<number>`
        count(distinct ${backup_configs.id}) +
        count(distinct ${volume_backup_configs.id})
      `,
    })
    .from(storage_destinations)
    .leftJoin(
      backup_configs,
      eq(backup_configs.destination_id, storage_destinations.id)
    )
    .leftJoin(
      volume_backup_configs,
      eq(volume_backup_configs.destination_id, storage_destinations.id)
    )
    .where(eq(storage_destinations.org_id, orgId))
    .groupBy(storage_destinations.id)

  return new Map(
    rows.map((row) => [row.destinationId, Number(row.usageCount ?? 0)])
  )
}
async function createCredentialsSecret(
  db: Pick<Db, "insert">,
  orgId: string,
  destinationId: string,
  credentials: StorageCredentialsInput
): Promise<string> {
  const encrypted = await encryptField(JSON.stringify(credentials))
  const secretId = `storage-destination-secret-${destinationId}`
  await db
    .insert(secrets)
    .values({
    id: secretId,
    app_id: null,
    project_id: orgId,
    scope: "shared",
    phase: "runtime",
    key: `storage-destination:${destinationId}`,
    value_ciphertext: encrypted.enc,
    nonce: encrypted.nonce,
    linked_database_id: null,
    created_at: new Date(),
    })
    .onConflictDoUpdate({
      target: secrets.id,
      set: {
        value_ciphertext: encrypted.enc,
        nonce: encrypted.nonce,
        project_id: orgId,
        app_id: null,
        linked_database_id: null,
        scope: "shared",
        phase: "runtime",
        key: `storage-destination:${destinationId}`,
      },
    })
  return secretId
}

function isUsedFieldChanged(
  existing: typeof storage_destinations.$inferSelect,
  update: {
    endpoint?: string | null | undefined
    bucket?: string | null | undefined
    region?: string | null | undefined
  }
): boolean {
  return (
    (update.endpoint !== undefined && update.endpoint !== existing.s3_endpoint) ||
    (update.bucket !== undefined && update.bucket !== existing.s3_bucket) ||
    (update.region !== undefined && update.region !== existing.s3_region)
  )
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_")
}

function destinationSnapshotWhere(
  destinationId: string,
  orgId: string,
  updatedAt: Date
) {
  return and(
    eq(storage_destinations.id, destinationId),
    eq(storage_destinations.org_id, orgId),
    sql`date_trunc('milliseconds', ${storage_destinations.updated_at}) = ${updatedAt.toISOString()}::timestamptz`
  )
}

export function createStorageDestinationsRouter(db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()
  const read = [requireScope("storage:read"), requireRole(db, ["owner", "member"])] as const
  const write = [requireScope("storage:write"), requireRole(db, ["owner"])] as const

  router.get("/:orgSlug/storage-destinations", ...read, async (c) => {
    const orgId = getOrgId(c)
    const rows = await db
      .select()
      .from(storage_destinations)
      .where(eq(storage_destinations.org_id, orgId))
      .orderBy(storage_destinations.name)
    const usageCounts = await usageCountsByDestination(db, orgId)
    const summaries = rows.map((destination) =>
      destinationSummary(destination, usageCounts.get(destination.id) ?? 0)
    )
    return c.json({
      destinations: summaries,
    })
  })

  router.post("/:orgSlug/storage-destinations", ...write, async (c) => {
    const orgId = getOrgId(c)
    const body = await c.req.json().catch(() => null)
    const parsed = CreateStorageDestinationSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        400
      )
    }

    const input = parsed.data
    const remote = input.kind !== "local"
    const id = nanoid()
    const destination = {
      id,
      org_id: orgId,
      name: input.name,
      kind: input.kind,
      provider: input.provider ?? null,
      s3_endpoint: remote ? input.endpoint ?? null : null,
      s3_bucket: remote ? input.bucket ?? null : null,
      s3_region: input.kind === "s3" ? input.region ?? null : null,
      credentials_secret_id: null as string | null,
      last_test_at: null,
      last_test_status: null,
      last_test_error: null,
      created_at: new Date(),
      updated_at: new Date(),
    }
    await db.transaction(async (tx) => {
      if (remote) {
        destination.credentials_secret_id = await createCredentialsSecret(
          tx,
          orgId,
          id,
          input.credentials!
        )
      }
      await tx.insert(storage_destinations).values(destination)
    })
    return c.json({ destination: destinationSummary(destination, 0) }, 201)
  })

  router.patch("/:orgSlug/storage-destinations/:id", ...write, async (c) => {
    const orgId = getOrgId(c)
    const destinationId = c.req.param("id")!
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
    const existing = rows[0]
    if (!existing) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Storage destination not found" } },
        404
      )
    }

    const body = await c.req.json().catch(() => null)
    const parsed = UpdateStorageDestinationSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        400
      )
    }
    const input = parsed.data
    const invalid = (message: string) =>
      c.json({ error: { code: "VALIDATION_ERROR", message } }, 400)
    if (input.credentials && existing.kind === "local") {
      return invalid("Local destinations do not accept credentials")
    }
    if (
      input.credentials &&
      !storageCredentialsMatchKind(existing.kind, input.credentials)
    ) {
      return invalid("Credentials do not match the destination type")
    }
    if (input.provider && STORAGE_PROVIDERS[input.provider].kind !== existing.kind) {
      return invalid("Provider does not match the destination type")
    }
    if (input.credentials === null && existing.kind !== "local") {
      return invalid("Credentials cannot be cleared on a remote destination")
    }
    if (input.bucket === null && existing.kind !== "local") {
      return invalid("Bucket cannot be cleared on a remote destination")
    }
    const updateResult = await db.transaction(async (tx) => {
      const lockedRows = await tx
        .select()
        .from(storage_destinations)
        .where(
          and(
            eq(storage_destinations.id, destinationId),
            eq(storage_destinations.org_id, orgId)
          )
        )
        .for("update")
        .limit(1)
      const locked = lockedRows[0]
      if (!locked) return { kind: "not_found" as const }

      const references = await tx.execute<{ count: string | number }>(sql`
        SELECT (
          (SELECT count(*) FROM backup_configs WHERE destination_id = ${destinationId}) +
          (SELECT count(*) FROM volume_backup_configs WHERE destination_id = ${destinationId})
        ) AS count
      `)
      const count = Number(Array.from(references)[0]?.count ?? 0)
      if (count > 0 && isUsedFieldChanged(locked, input)) {
        return { kind: "in_use" as const }
      }

      let credentialsSecretId = locked.credentials_secret_id
      if (input.credentials !== undefined && input.credentials !== null) {
        credentialsSecretId = await createCredentialsSecret(
          tx,
          orgId,
          destinationId,
          input.credentials
        )
      }
      const destinationChanged =
        input.endpoint !== undefined ||
        input.bucket !== undefined ||
        input.region !== undefined ||
        input.credentials !== undefined
      const rows = await tx
        .update(storage_destinations)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.endpoint !== undefined ? { s3_endpoint: input.endpoint } : {}),
          ...(input.bucket !== undefined ? { s3_bucket: input.bucket } : {}),
          ...(input.region !== undefined ? { s3_region: input.region } : {}),
          ...(input.credentials !== undefined
            ? { credentials_secret_id: credentialsSecretId }
            : {}),
          ...(destinationChanged
            ? {
                last_test_at: null,
                last_test_status: null,
                last_test_error: null,
              }
            : {}),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(storage_destinations.id, destinationId),
            eq(storage_destinations.org_id, orgId)
          )
        )
        .returning()
      return { kind: "updated" as const, rows, count }
    })
    if (updateResult.kind === "not_found") {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Storage destination not found" } },
        404
      )
    }
    if (updateResult.kind === "in_use") {
      return c.json(
        {
          error: {
            code: "DESTINATION_IN_USE",
            message: "Endpoint, bucket, or region cannot change while backups use this destination",
          },
        },
        409
      )
    }
    const updated = updateResult.rows[0]
    if (!updated) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Storage destination not found" } },
        404
      )
    }
    return c.json({ destination: destinationSummary(updated, updateResult.count) })
  })

  router.delete("/:orgSlug/storage-destinations/:id", ...write, async (c) => {
    const orgId = getOrgId(c)
    const destinationId = c.req.param("id")!
    try {
      const deleted = await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(storage_destinations)
          .where(
            and(
              eq(storage_destinations.id, destinationId),
              eq(storage_destinations.org_id, orgId)
            )
          )
          .for("update")
          .limit(1)
        if (!locked[0]) return { found: false, inUse: false }
        const references = await tx.execute<{ count: string | number }>(sql`
          SELECT (
            (SELECT count(*) FROM backup_configs WHERE destination_id = ${destinationId}) +
            (SELECT count(*) FROM volume_backup_configs WHERE destination_id = ${destinationId})
          ) AS count
        `)
        if (Number(Array.from(references)[0]?.count ?? 0) > 0) {
          return { found: true, inUse: true }
        }
        await tx
          .delete(storage_destinations)
          .where(
            and(
              eq(storage_destinations.id, destinationId),
              eq(storage_destinations.org_id, orgId)
            )
          )
        const ownSecretId = `storage-destination-secret-${destinationId}`
        await tx.execute(sql`
          DELETE FROM secrets
          WHERE id = ${ownSecretId}
            AND NOT EXISTS (
              SELECT 1 FROM storage_destinations WHERE credentials_secret_id = ${ownSecretId}
            )
            AND NOT EXISTS (
              SELECT 1 FROM backup_configs WHERE s3_credentials_secret_id = ${ownSecretId}
            )
            AND NOT EXISTS (
              SELECT 1 FROM volume_backup_configs WHERE s3_credentials_secret_id = ${ownSecretId}
            )
        `)
        return { found: true, inUse: false }
      })
      if (!deleted.found) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Storage destination not found" } },
          404
        )
      }
      if (deleted.inUse) {
        return c.json(
          {
            error: {
              code: "DESTINATION_IN_USE",
              message: "Storage destination is used by one or more backup configs",
            },
          },
          409
        )
      }
      return c.json({ ok: true })
    } catch (error) {
      if ((error as { code?: string }).code === "23503") {
        return c.json(
          {
            error: {
              code: "DESTINATION_IN_USE",
              message: "Storage destination is used by one or more backup configs",
            },
          },
          409
        )
      }
      throw error
    }
  })

  router.post("/:orgSlug/storage-destinations/:id/test", ...write, async (c) => {
    const orgId = getOrgId(c)
    const destinationId = c.req.param("id")!
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
    const destination = rows[0]
    if (!destination) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Storage destination not found" } },
        404
      )
    }

    const body = (await c.req.json().catch(() => null)) as {
      createBucket?: unknown
    } | null
    const createBucket = body?.createBucket === true
    let bucketCreated = false

    const testedAt = new Date()
    try {
      if (destination.kind !== "local") {
        if (!destination.s3_bucket || !destination.credentials_secret_id) {
          throw new Error("incomplete destination")
        }
        const secretRows = await db
          .select()
          .from(secrets)
          .where(eq(secrets.id, destination.credentials_secret_id))
          .limit(1)
        const secret = secretRows[0]
        if (!secret) throw new Error("missing destination credentials")
        const { decryptSecret } = await import("../secrets/crypto")
        const plaintext = await decryptSecret(
          secret.value_ciphertext as Buffer,
          secret.nonce as Buffer
        )
        const store = await openObjectStore({
          kind: destination.kind,
          endpoint: destination.s3_endpoint,
          bucket: destination.s3_bucket,
          region: destination.s3_region,
          credentials: parseDestinationCredentials(destination.kind, plaintext),
        })
        const key = `.ploydok/destination-tests/${destination.id}/${nanoid()}.txt`
        const marker = `ploydok-storage-test:${destination.id}:${nanoid()}`
        try {
          if (createBucket) {
            bucketCreated =
              (await store.ensureBucket(AbortSignal.timeout(15_000))) === "created"
          }
          // Mark this before PUT so a provider that writes then times out still
          // gets a best-effort delete in the cleanup path.
          let witnessCreated = true
          let operationError: unknown
          try {
            await store.put(key, marker, AbortSignal.timeout(10_000))
            const stream = await store.download(key, AbortSignal.timeout(10_000))
            const chunks: Buffer[] = []
            let size = 0
            const bodyTimeout = setTimeout(() => {
              stream.destroy(new Error("destination witness read timed out"))
            }, 10_000)
            try {
              for await (const chunk of stream) {
                const bytes = Buffer.from(chunk)
                size += bytes.length
                if (size > Buffer.byteLength(marker)) {
                  stream.destroy()
                  throw new Error("destination witness exceeded size limit")
                }
                chunks.push(bytes)
              }
            } finally {
              clearTimeout(bodyTimeout)
            }
            if (Buffer.concat(chunks).toString("utf8") !== marker) {
              throw new Error("destination witness mismatch")
            }
          } catch (error) {
            operationError = error
          }
          if (witnessCreated) {
            try {
              await store.delete(key, AbortSignal.timeout(10_000))
              witnessCreated = false
            } catch (error) {
              operationError ??= error
            }
          }
          if (operationError) {
            throw operationError
          }
        } finally {
          store.close()
        }
      } else {
        const root = path.join(
          env.PLOYDOK_BUILD_DIR,
          "..",
          "backups",
          ".destination-tests"
        )
        const witness = path.join(
          root,
          `${safePathSegment(orgId)}-${safePathSegment(destination.id)}-${nanoid()}.txt`
        )
        const marker = `ploydok-storage-test:${destination.id}:${nanoid()}`
        await mkdir(root, { recursive: true })
        try {
          await writeFile(witness, marker, { encoding: "utf8", flag: "wx" })
          const value = await readFile(witness, "utf8")
          if (value !== marker) throw new Error("destination witness mismatch")
        } finally {
          await rm(witness, { force: true })
        }
      }
      const updatedRows = await db
        .update(storage_destinations)
        .set({
          last_test_at: testedAt,
          last_test_status: "success",
          last_test_error: null,
          updated_at: new Date(),
        })
        .where(
          destinationSnapshotWhere(destinationId, orgId, destination.updated_at)
        )
        .returning()
      if (!updatedRows[0]) {
        return c.json(
          {
            error: {
              code: "DESTINATION_CHANGED",
              message: "Storage destination changed while it was being tested",
            },
          },
          409
        )
      }
      return c.json({
        ok: true,
        bucketCreated,
        testedAt: testedAt.toISOString(),
        destination: destinationSummary(updatedRows[0] ?? destination, await usageCount(db, destinationId)),
      })
    } catch (error) {
      // Only the classified reason is stored and returned: provider messages
      // can echo endpoints or key identifiers.
      const reason: StorageFailureReason = classifyStorageError(error)
      const failedRows = await db
        .update(storage_destinations)
        .set({
          last_test_at: testedAt,
          last_test_status: "failure",
          last_test_error: reason,
          updated_at: new Date(),
        })
        .where(
          destinationSnapshotWhere(destinationId, orgId, destination.updated_at)
        )
        .returning()
      if (!failedRows[0]) {
        return c.json(
          {
            error: {
              code: "DESTINATION_CHANGED",
              message: "Storage destination changed while it was being tested",
            },
          },
          409
        )
      }
      return c.json(
        {
          error: {
            code: "DESTINATION_TEST_FAILED",
            message: "Storage destination test failed",
            reason,
          },
        },
        502
      )
    }
  })

  return router
}
