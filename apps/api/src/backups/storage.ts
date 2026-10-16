// SPDX-License-Identifier: AGPL-3.0-only
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { Transform, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { eq } from "drizzle-orm"
import { secrets, storage_destinations } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { env } from "../env"
import { decryptSecret } from "../secrets/crypto"
import {
  buildRemoteLocation,
  isMissingObjectError,
  isRemoteLocation,
  openObjectStore,
  parseRemoteLocation,
  type ObjectStore,
  type ObjectStoreCredentials,
} from "../storage/object-store"

export type BackupDestinationKind = "s3" | "azure" | "local"

export interface BackupDestinationConfig {
  destination_id?: string | null
  destination_updated_at?: Date | null
  destination_kind: BackupDestinationKind
  s3_endpoint: string | null
  s3_bucket: string | null
  s3_prefix: string | null
  s3_region: string | null
  s3_credentials_secret_id: string | null
}

export interface S3BackedConfig {
  destination_id?: string | null
  destination_updated_at?: Date | null
  destination_kind?: BackupDestinationKind | null
  s3_endpoint?: string | null
  s3_bucket?: string | null
  s3_prefix?: string | null
  s3_region?: string | null
  s3_credentials_secret_id?: string | null
}

/** One opened destination, reused across the probes of a request. */
export interface BackupStoreProbe {
  store: ObjectStore
}

export interface BackupArtifactMetadata {
  sizeBytes: number
  lastModifiedAt: Date
}

class ByteCounter extends Transform {
  bytes = 0

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer | string) => void
  ): void {
    const size =
      typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.length
    this.bytes += size
    callback(null, chunk)
  }
}

/**
 * Folder of one local destination. Built from immutable ids so renaming the
 * destination never moves files; it plays the role of a bucket.
 */
export function localDestinationDir(
  orgId: string | null,
  destinationId: string | null
): string {
  const root = path.resolve(env.PLOYDOK_LOCAL_STORAGE_DIR)
  if (!orgId || !destinationId) return path.join(root, "unassigned")
  return path.join(root, orgId, destinationId)
}

/** Local backup path: the remote object key, under the destination folder. */
export function localBackupPath(destinationDir: string, key: string): string {
  const base = path.join(destinationDir, "backups")
  const location = path.resolve(base, key)
  // The key carries the user-defined prefix: refuse anything that climbs out.
  if (!location.startsWith(`${base}${path.sep}`)) {
    throw new Error("Backup key escapes the local destination folder")
  }
  return location
}

/**
 * Location of a new artifact: an object URL for a remote destination, a path
 * in the local destination folder otherwise. Both use the same key.
 */
export async function buildBackupLocation(
  db: Db,
  config: Pick<
    BackupDestinationConfig,
    "destination_kind" | "destination_id" | "s3_bucket"
  >,
  key: string
): Promise<string> {
  if (config.destination_kind === "local") {
    const rows = config.destination_id
      ? await db
          .select({ orgId: storage_destinations.org_id })
          .from(storage_destinations)
          .where(eq(storage_destinations.id, config.destination_id))
          .limit(1)
      : []
    const orgId = rows[0]?.orgId ?? null
    return localBackupPath(
      localDestinationDir(orgId, orgId ? (config.destination_id ?? null) : null),
      key
    )
  }
  if (!config.s3_bucket) {
    throw new Error("Remote backup config is missing its bucket")
  }
  return buildRemoteLocation(config.destination_kind, config.s3_bucket, key)
}

export async function writeBackupStream(
  db: Db,
  config: BackupDestinationConfig,
  location: string,
  source: Readable
): Promise<{ sizeBytes: number }> {
  const resolvedConfig = await resolveBackupDestination(db, config)
  const counter = new ByteCounter()

  if (resolvedConfig.destination_kind !== "local") {
    if (!resolvedConfig.s3_bucket) {
      throw new Error("Remote backup config is missing its bucket")
    }
    const store = await openBackupStore(db, resolvedConfig)
    try {
      const { key } = parseRemoteLocation(location)
      await store.upload(key, source.pipe(counter))
    } finally {
      store.close()
    }
    return { sizeBytes: counter.bytes }
  }

  await mkdir(path.dirname(location), { recursive: true })
  await pipeline(source, counter, createWriteStream(location))
  return { sizeBytes: counter.bytes }
}

export async function deleteBackupArtifact(
  db: Db,
  location: string,
  config: S3BackedConfig | null
): Promise<void> {
  if (isRemoteLocation(location)) {
    if (!config) return

    const { key, ...target } = parseRemoteLocation(location)
    const store = await openBackupStore(db, config, target)
    try {
      await store.delete(key)
    } finally {
      store.close()
    }
    return
  }

  const { unlink } = await import("node:fs/promises")
  await unlink(location).catch(() => {})
}

/** Open the stored artifact for reading (restore, download). */
export async function openBackupArtifact(
  db: Db,
  location: string,
  config: S3BackedConfig | null
): Promise<Readable> {
  if (!isRemoteLocation(location)) return createReadStream(location)
  if (!config) throw new Error("Remote backup configuration is unavailable")
  const { key, ...target } = parseRemoteLocation(location)
  const store = await openBackupStore(db, config, target)
  const stream = await store.download(key)
  stream.once("close", () => store.close())
  return stream
}

/**
 * Confirm that a backup artifact still exists and return metadata from the
 * destination itself. The database row is deliberately not used as proof of
 * presence because retention, manual deletion, and external lifecycle rules
 * can remove the object independently.
 */
export async function inspectBackupArtifact(
  db: Db,
  location: string,
  config: S3BackedConfig | null,
  probe?: BackupStoreProbe,
): Promise<BackupArtifactMetadata | null> {
  if (isRemoteLocation(location)) {
    if (!config) {
      throw new Error("Remote backup configuration is unavailable")
    }

    const { key, ...target } = parseRemoteLocation(location)
    const reusable =
      probe &&
      probe.store.scheme === target.scheme &&
      probe.store.bucket === target.bucket
    const store = reusable
      ? probe.store
      : await openBackupStore(db, config, target)
    let object
    try {
      object = await store.head(key)
    } catch (error) {
      if (isMissingObjectError(error)) return null
      throw error
    } finally {
      if (!reusable) store.close()
    }
    if (!object.lastModified) return null
    return {
      sizeBytes: object.size,
      lastModifiedAt: object.lastModified,
    }
  }

  const metadata = await stat(location).catch((error: unknown) => {
    if (isMissingLocalArtifactError(error)) return null
    throw error
  })
  if (!metadata?.isFile()) return null
  return {
    sizeBytes: metadata.size,
    lastModifiedAt: metadata.mtime,
  }
}

function isMissingLocalArtifactError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

/** Decrypt a destination secret and check it has the shape of its kind. */
export function parseDestinationCredentials(
  kind: "s3" | "azure",
  plaintext: string
): ObjectStoreCredentials {
  const value = JSON.parse(plaintext) as Record<string, unknown>
  if (kind === "azure") {
    if (typeof value.accountName !== "string" || typeof value.accountKey !== "string") {
      throw new Error(
        "Azure credentials secret has unexpected format (expected { accountName, accountKey })"
      )
    }
    return { accountName: value.accountName, accountKey: value.accountKey }
  }
  if (typeof value.accessKeyId !== "string" || typeof value.secretAccessKey !== "string") {
    throw new Error(
      "S3 credentials secret has unexpected format (expected { accessKeyId, secretAccessKey })"
    )
  }
  return {
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
  }
}

export async function resolveDestinationCredentials(
  db: Db,
  config: S3BackedConfig,
  scheme?: "s3" | "azure"
): Promise<ObjectStoreCredentials> {
  const resolvedConfig = await resolveBackupDestination(db, config)
  return readDestinationCredentials(
    db,
    resolvedConfig.s3_credentials_secret_id,
    scheme ?? remoteKind(resolvedConfig.destination_kind)
  )
}

async function readDestinationCredentials(
  db: Db,
  secretId: string | null,
  kind: "s3" | "azure"
): Promise<ObjectStoreCredentials> {
  if (!secretId) {
    throw new Error("Remote backup config is missing its credentials secret")
  }
  const secretRows = await db
    .select()
    .from(secrets)
    .where(eq(secrets.id, secretId))
    .limit(1)
  const secret = secretRows[0]
  if (!secret || !secret.value_ciphertext || !secret.nonce) {
    throw new Error("Destination credentials secret not found or missing ciphertext")
  }

  const plaintext = await decryptSecret(
    secret.value_ciphertext as Buffer,
    secret.nonce as Buffer
  )
  return parseDestinationCredentials(kind, plaintext)
}

function remoteKind(kind: BackupDestinationKind | null | undefined): "s3" | "azure" {
  return kind === "azure" ? "azure" : "s3"
}

/**
 * Open the object store of a destination. `target` comes from an artifact
 * location when there is one: the artifact, not the current config, says
 * which protocol and bucket hold it.
 */
export async function openBackupStore(
  db: Db,
  config: S3BackedConfig,
  target?: { scheme: "s3" | "azure"; bucket: string }
): Promise<ObjectStore> {
  const resolvedConfig = await resolveBackupDestination(db, config)
  const kind = target?.scheme ?? remoteKind(resolvedConfig.destination_kind)
  const credentials = await readDestinationCredentials(
    db,
    resolvedConfig.s3_credentials_secret_id,
    kind
  )
  return openObjectStore({
    kind,
    endpoint: resolvedConfig.s3_endpoint,
    bucket: target?.bucket ?? resolvedConfig.s3_bucket ?? "",
    region: resolvedConfig.s3_region,
    credentials,
  })
}

/** Resolve credentials and open one destination for a request scope. */
export async function createBackupStoreProbe(
  db: Db,
  config: S3BackedConfig,
  target?: { scheme: "s3" | "azure"; bucket: string }
): Promise<BackupStoreProbe> {
  return { store: await openBackupStore(db, config, target) }
}

/** Resolve the latest workspace destination while retaining legacy fallback. */
type ResolvedDestinationFields = Omit<BackupDestinationConfig, "destination_id"> & {
  destination_id: string | null
}
type ResolvedBackupDestination<T extends BackupDestinationConfig | S3BackedConfig> =
  Omit<T, keyof BackupDestinationConfig> & ResolvedDestinationFields

export async function resolveBackupDestination<
  T extends BackupDestinationConfig | S3BackedConfig,
>(
  db: Db,
  config: T
): Promise<ResolvedBackupDestination<T>> {
  if (!config.destination_id) {
    return {
      ...config,
      destination_id: config.destination_id ?? null,
      destination_updated_at: null,
      destination_kind: config.destination_kind ?? "local",
      s3_endpoint: config.s3_endpoint ?? null,
      s3_bucket: config.s3_bucket ?? null,
      s3_prefix: config.s3_prefix ?? null,
      s3_region: config.s3_region ?? null,
      s3_credentials_secret_id: config.s3_credentials_secret_id ?? null,
    } as unknown as ResolvedBackupDestination<T>
  }

  const rows = await db
    .select()
    .from(storage_destinations)
    .where(eq(storage_destinations.id, config.destination_id))
    .limit(1)
  const destination = rows[0]
  if (!destination) {
    // A legacy row can be read during a partially completed deployment. Its
    // inline fields remain the safest fallback until the link is repaired.
    return {
      ...config,
      destination_id: config.destination_id ?? null,
      destination_updated_at: null,
      destination_kind: config.destination_kind ?? "local",
      s3_endpoint: config.s3_endpoint ?? null,
      s3_bucket: config.s3_bucket ?? null,
      s3_prefix: config.s3_prefix ?? null,
      s3_region: config.s3_region ?? null,
      s3_credentials_secret_id: config.s3_credentials_secret_id ?? null,
    } as unknown as ResolvedBackupDestination<T>
  }
  return {
    ...config,
    destination_id: destination.id,
    destination_updated_at: destination.updated_at,
    destination_kind: destination.kind,
    s3_endpoint: destination.s3_endpoint,
    s3_bucket: destination.s3_bucket,
    s3_prefix: config.s3_prefix ?? null,
    s3_region: destination.s3_region,
    s3_credentials_secret_id: destination.credentials_secret_id,
  } as unknown as ResolvedBackupDestination<T>
}

export function buildBackupFilename(
  startedAt: Date,
  extension: string,
  encrypted: boolean
): string {
  const ts = startedAt.toISOString().replace(/[:.]/g, "-")
  return `${ts}.${extension}${encrypted ? ".age" : ""}`
}
