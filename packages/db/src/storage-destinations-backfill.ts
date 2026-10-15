// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm"
import type { Db } from "./client"

type StorageBackfillRow = {
  id: string
  org_id: string
  name: string
  kind: "s3" | "local"
  s3_endpoint: string | null
  s3_bucket: string | null
  s3_region: string | null
  credentials_secret_id: string | null
  value_ciphertext: Buffer | null
  nonce: Buffer | null
  secret_created_at: Date | string | null
}

type DbExecutor = Pick<Db, "execute">
type TransactionalDb = {
  transaction<T>(callback: (tx: DbExecutor) => Promise<T>): Promise<T>
}

const LEGACY_DESTINATION_NAME = "Migrated backup destination"

/**
 * Merge the candidate destinations made by the storage destination migration.
 * Secret ciphertext cannot be grouped in SQL because AES-GCM uses a random
 * nonce for every encryption. This pass compares decrypted credential values
 * and runs in one transaction so a destination never points at a
 * resource-owned secret while its config links are being moved.
 *
 * If the master key is unavailable (for example, a standalone migration run
 * before the API environment is loaded), secret ids are used as a safe
 * temporary discriminator and those rows remain candidates for a later boot.
 * Only rows that still have the migration placeholder name are candidates.
 * Once a row has been renamed, it is treated as user-owned and is never
 * reconsidered by a later boot.
 */
export async function backfillStorageDestinations(
  db: TransactionalDb,
  masterKey = Bun.env["MASTER_KEY"]
): Promise<{ destinations: number; merged: number }> {
  return db.transaction(async (tx) => {
    const rows = Array.from(
      await tx.execute<StorageBackfillRow>(sql`
      SELECT
        d.id,
        d.org_id,
        d.name,
        d.kind,
        d.s3_endpoint,
        d.s3_bucket,
        d.s3_region,
        d.credentials_secret_id,
        s.value_ciphertext,
        s.nonce,
        s.created_at AS secret_created_at
      FROM storage_destinations d
      LEFT JOIN secrets s ON s.id = d.credentials_secret_id
      WHERE d.id LIKE 'legacy-%'
        AND d.name = ${LEGACY_DESTINATION_NAME}
      ORDER BY d.created_at ASC, d.id ASC
      FOR UPDATE OF d
      `)
    )

    const canonicalBySecretId = new Map<string, string | null>()
    const keyByDestinationId = new Map<string, string>()
    const credentialResolvedByDestinationId = new Map<string, boolean>()
    const ownerByKey = new Map<string, StorageBackfillRow>()
    let merged = 0

    for (const row of rows) {
      const credential = await credentialIdentity(
        row,
        masterKey,
        canonicalBySecretId
      )
      const key = [
        row.org_id,
        row.kind,
        row.s3_endpoint ?? "",
        row.s3_bucket ?? "",
        row.s3_region ?? "",
        credential.key,
      ].join("\u0000")
      keyByDestinationId.set(row.id, key)
      credentialResolvedByDestinationId.set(row.id, credential.resolved)

      const owner = ownerByKey.get(key)
      if (!owner) {
        ownerByKey.set(key, row)
        continue
      }
      merged += 1
    }

    // Clone every candidate secret before a destination can outlive its
    // database/app. The clone is workspace-owned and has no cascading
    // resource FK. The same transaction also moves config links and removes
    // duplicate rows, so a failed boot rolls back the whole operation.
    for (const owner of ownerByKey.values()) {
      await rehomeSecret(tx, owner)
    }

    for (const owner of ownerByKey.values()) {
      if (credentialResolvedByDestinationId.get(owner.id)) {
        await renameMigratedDestination(tx, owner)
      }
    }

    for (const row of rows) {
      const key = keyByDestinationId.get(row.id)
      const owner = key ? ownerByKey.get(key) : undefined
      if (!owner || owner.id === row.id) continue
      await repointDestination(tx, row.id, owner.id)
      await tx.execute(sql`
        DELETE FROM storage_destinations
        WHERE id = ${row.id}
          AND NOT EXISTS (
            SELECT 1 FROM backup_configs WHERE destination_id = ${row.id}
          )
          AND NOT EXISTS (
            SELECT 1 FROM volume_backup_configs WHERE destination_id = ${row.id}
          )
      `)
      await deleteOrphanedClone(tx, row.id)
    }

    return { destinations: rows.length - merged, merged }
  })
}

function readableMigratedName(destination: StorageBackfillRow): string {
  if (destination.kind === "local") return "Migrated local backup destination"
  const bucket = destination.s3_bucket?.trim() || "unknown bucket"
  const endpoint = destination.s3_endpoint?.trim() || "default endpoint"
  return `Migrated S3: ${bucket} (${endpoint})`
}

async function renameMigratedDestination(
  db: DbExecutor,
  destination: StorageBackfillRow
): Promise<void> {
  await db.execute(sql`
    UPDATE storage_destinations
    SET name = ${readableMigratedName(destination)}, updated_at = now()
    WHERE id = ${destination.id}
      AND name = ${LEGACY_DESTINATION_NAME}
  `)
}

async function rehomeSecret(
  db: DbExecutor,
  destination: StorageBackfillRow
): Promise<void> {
  if (!destination.credentials_secret_id) return
  if (!destination.value_ciphertext || !destination.nonce) return

  const cloneId = `storage-destination-secret-${destination.id}`
  const createdAt = destination.secret_created_at ?? new Date()
  await db.execute(sql`
    INSERT INTO secrets (
      id, app_id, project_id, scope, phase, key,
      value_ciphertext, nonce, linked_database_id, created_at
    ) VALUES (
      ${cloneId}, NULL, ${destination.org_id}, 'shared', 'runtime',
      ${`storage-destination:${destination.id}`},
      ${destination.value_ciphertext}, ${destination.nonce}, NULL, ${createdAt}
    )
    ON CONFLICT (id) DO NOTHING
  `)
  await db.execute(sql`
    UPDATE storage_destinations
    SET credentials_secret_id = ${cloneId}, updated_at = now()
    WHERE id = ${destination.id}
  `)
}

async function repointDestination(
  db: DbExecutor,
  duplicateId: string,
  ownerId: string
): Promise<void> {
  await db.execute(sql`
    UPDATE backup_configs
    SET destination_id = ${ownerId}
    WHERE destination_id = ${duplicateId}
  `)
  await db.execute(sql`
    UPDATE volume_backup_configs
    SET destination_id = ${ownerId}
    WHERE destination_id = ${duplicateId}
  `)
}

async function deleteOrphanedClone(
  db: DbExecutor,
  destinationId: string
): Promise<void> {
  const cloneId = `storage-destination-secret-${destinationId}`
  await db.execute(sql`
    DELETE FROM secrets
    WHERE id = ${cloneId}
      AND NOT EXISTS (
        SELECT 1
        FROM storage_destinations
        WHERE credentials_secret_id = ${cloneId}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM backup_configs
        WHERE s3_credentials_secret_id = ${cloneId}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM volume_backup_configs
        WHERE s3_credentials_secret_id = ${cloneId}
      )
  `)
}

async function credentialIdentity(
  row: StorageBackfillRow,
  masterKey: string | undefined,
  cache: Map<string, string | null>
): Promise<{ key: string; resolved: boolean }> {
  if (!row.credentials_secret_id) return { key: "", resolved: true }
  if (!masterKey) {
    return { key: `secret:${row.credentials_secret_id}`, resolved: false }
  }

  let canonical = cache.get(row.credentials_secret_id)
  if (canonical === undefined) {
    canonical = await decryptCredentials(row.value_ciphertext, row.nonce, masterKey)
    cache.set(row.credentials_secret_id, canonical)
  }
  return {
    key: canonical ?? `secret:${row.credentials_secret_id}`,
    resolved: canonical !== null,
  }
}

async function decryptCredentials(
  ciphertext: Buffer | null,
  nonce: Buffer | null,
  masterKey: string
): Promise<string | null> {
  if (!ciphertext || !nonce) return null
  try {
    const raw = Buffer.from(masterKey, "base64")
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(raw),
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    )
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(nonce) },
      key,
      new Uint8Array(ciphertext)
    )
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const value = parsed as Record<string, unknown>
    if (typeof value.accessKeyId !== "string" || typeof value.secretAccessKey !== "string") {
      return null
    }
    return JSON.stringify({
      accessKeyId: value.accessKeyId,
      secretAccessKey: value.secretAccessKey,
    })
  } catch {
    return null
  }
}
