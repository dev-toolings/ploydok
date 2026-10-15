// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm"
import type { Db } from "./client"

type StorageBackfillRow = {
  id: string
  org_id: string
  kind: "s3" | "local"
  s3_endpoint: string | null
  s3_bucket: string | null
  s3_region: string | null
  credentials_secret_id: string | null
  value_ciphertext: Buffer | null
  nonce: Buffer | null
  secret_project_id: string | null
  secret_app_id: string | null
  secret_linked_database_id: string | null
  secret_scope: "shared" | "prod" | "preview" | "dev" | null
  secret_phase: "build" | "runtime" | "both" | null
  secret_key: string | null
  secret_created_at: Date | string | null
}

/**
 * Merge the candidate destinations made by migration 0089. Secret ciphertext
 * cannot be grouped in SQL because AES-GCM uses a random nonce for every
 * encryption. This pass compares decrypted credential values and is safe to
 * run repeatedly: it only repoints configs and removes unreferenced dupes.
 *
 * If the master key is unavailable (for example, a standalone migration run
 * before the API environment is loaded), the secret id is used as a safe
 * temporary discriminator. A later API boot with the key performs the value
 * based merge.
 */
export async function backfillStorageDestinations(
  db: Pick<Db, "execute">,
  masterKey = Bun.env["MASTER_KEY"]
): Promise<{ destinations: number; merged: number }> {
  const rows = Array.from(
    await db.execute<StorageBackfillRow>(sql`
      SELECT
        d.id,
        d.org_id,
        d.kind,
        d.s3_endpoint,
        d.s3_bucket,
        d.s3_region,
        d.credentials_secret_id,
        s.value_ciphertext,
        s.nonce
        ,s.project_id AS secret_project_id
        ,s.app_id AS secret_app_id
        ,s.linked_database_id AS secret_linked_database_id
        ,s.scope AS secret_scope
        ,s.phase AS secret_phase
        ,s.key AS secret_key
        ,s.created_at AS secret_created_at
      FROM storage_destinations d
      LEFT JOIN secrets s ON s.id = d.credentials_secret_id
      WHERE d.id LIKE 'legacy-%'
      ORDER BY d.created_at ASC, d.id ASC
    `)
  )

  const canonicalBySecretId = new Map<string, string | null>()
  const keyByDestinationId = new Map<string, string>()
  const ownerByKey = new Map<string, StorageBackfillRow>()
  let merged = 0

  for (const row of rows) {
    const credentialKey = await credentialIdentity(row, masterKey, canonicalBySecretId)
    const key = [
      row.org_id,
      row.kind,
      row.s3_endpoint ?? "",
      row.s3_bucket ?? "",
      row.s3_region ?? "",
      credentialKey,
    ].join("\u0000")
    keyByDestinationId.set(row.id, key)

    const owner = ownerByKey.get(key)
    if (!owner) {
      ownerByKey.set(key, row)
      continue
    }
    merged += 1
  }

  // Re-home legacy resource-linked secrets before a destination can outlive
  // its database/app. The ciphertext and nonce are preserved exactly, while
  // the new row is owned by the workspace and has no cascading resource FK.
  for (const owner of ownerByKey.values()) {
    await rehomeSecret(db, owner)
  }

  for (const row of rows) {
    const key = keyByDestinationId.get(row.id)
    const owner = key ? ownerByKey.get(key) : undefined
    if (!owner || owner.id === row.id) continue
    await repointDestination(db, row.id, owner.id)
    await db.execute(sql`
      DELETE FROM storage_destinations
      WHERE id = ${row.id}
        AND NOT EXISTS (
          SELECT 1 FROM backup_configs WHERE destination_id = ${row.id}
        )
        AND NOT EXISTS (
          SELECT 1 FROM volume_backup_configs WHERE destination_id = ${row.id}
        )
    `)
  }

  return { destinations: rows.length - merged, merged }
}

async function rehomeSecret(
  db: Pick<Db, "execute">,
  destination: StorageBackfillRow
): Promise<void> {
  if (!destination.credentials_secret_id) return
  const alreadyWorkspaceOwned =
    destination.secret_project_id === destination.org_id &&
    destination.secret_app_id === null &&
    destination.secret_linked_database_id === null
  if (alreadyWorkspaceOwned) return
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
  db: Pick<Db, "execute">,
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

async function credentialIdentity(
  row: StorageBackfillRow,
  masterKey: string | undefined,
  cache: Map<string, string | null>
): Promise<string> {
  if (!row.credentials_secret_id) return ""
  if (!masterKey) return `secret:${row.credentials_secret_id}`

  let canonical = cache.get(row.credentials_secret_id)
  if (canonical === undefined) {
    canonical = await decryptCredentials(row.value_ciphertext, row.nonce, masterKey)
    cache.set(row.credentials_secret_id, canonical)
  }
  return canonical ?? `secret:${row.credentials_secret_id}`
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
