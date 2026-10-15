// SPDX-License-Identifier: AGPL-3.0-only
import { createWriteStream } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { Transform, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { eq } from "drizzle-orm"
import { secrets } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import type { BackupConfigRow, VolumeBackupConfigRow } from "@ploydok/db"
import { decryptSecret } from "../secrets/crypto"
import {
  createS3Client,
  deleteObject,
  headObject,
  uploadStream,
} from "../storage/s3"
import type { S3Client } from "@aws-sdk/client-s3"

export type S3BackedConfig = Pick<
  BackupConfigRow,
  "s3_endpoint" | "s3_region" | "s3_credentials_secret_id"
> &
  Pick<VolumeBackupConfigRow, "s3_endpoint" | "s3_region" | "s3_credentials_secret_id">

type BackupDestinationConfig = Pick<
  BackupConfigRow,
  | "destination_kind"
  | "s3_endpoint"
  | "s3_bucket"
  | "s3_prefix"
  | "s3_region"
  | "s3_credentials_secret_id"
> &
  Pick<
    VolumeBackupConfigRow,
    | "destination_kind"
    | "s3_endpoint"
    | "s3_bucket"
    | "s3_prefix"
    | "s3_region"
    | "s3_credentials_secret_id"
  >

export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface BackupS3Probe {
  client: S3Client
  credentials: S3Credentials
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

export async function writeBackupStream(
  db: Db,
  config: BackupDestinationConfig,
  location: string,
  source: Readable
): Promise<{ sizeBytes: number }> {
  const counter = new ByteCounter()

  if (config.destination_kind === "s3") {
    if (!config.s3_bucket) {
      throw new Error("S3 backup config is missing s3_bucket")
    }

    const creds = await resolveS3Credentials(db, config)
    const client = createS3Client({
      ...(config.s3_endpoint ? { endpoint: config.s3_endpoint } : {}),
      region: config.s3_region ?? "auto",
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    })

    const { bucket, key } = parseS3Location(location)
    await uploadStream(client, bucket, key, source.pipe(counter))
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
  if (location.startsWith("s3://")) {
    if (!config) return

    const creds = await resolveS3Credentials(db, config)
    const client = createS3Client({
      ...(config.s3_endpoint ? { endpoint: config.s3_endpoint } : {}),
      region: config.s3_region ?? "auto",
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    })
    const { bucket, key } = parseS3Location(location)
    await deleteObject(client, bucket, key)
    return
  }

  const { unlink } = await import("node:fs/promises")
  await unlink(location).catch(() => {})
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
  probe?: BackupS3Probe,
): Promise<BackupArtifactMetadata | null> {
  if (location.startsWith("s3://")) {
    if (!config) {
      throw new Error("S3 backup configuration is unavailable")
    }

    const resources = probe ?? (await createBackupS3Probe(db, config))
    const { bucket, key } = parseS3Location(location)
    let object
    try {
      object = await headObject(resources.client, bucket, key)
    } catch (error) {
      if (isMissingS3ObjectError(error)) return null
      throw error
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

function isMissingS3ObjectError(error: unknown): boolean {
  const candidate = error as
    | {
        name?: string
        Code?: string
        $metadata?: { httpStatusCode?: number }
      }
    | undefined
  return (
    candidate?.$metadata?.httpStatusCode === 404 ||
    candidate?.name === "NotFound" ||
    candidate?.name === "NoSuchKey" ||
    candidate?.Code === "NotFound" ||
    candidate?.Code === "NoSuchKey"
  )
}

export async function resolveS3Credentials(
  db: Db,
  config: S3BackedConfig
): Promise<S3Credentials> {
  if (!config.s3_credentials_secret_id) {
    throw new Error("S3 backup config is missing s3_credentials_secret_id")
  }

  const secretRows = await db
    .select()
    .from(secrets)
    .where(eq(secrets.id, config.s3_credentials_secret_id))
    .limit(1)
  const secret = secretRows[0]
  if (!secret || !secret.value_ciphertext || !secret.nonce) {
    throw new Error("S3 credentials secret not found or missing ciphertext")
  }

  const plaintext = await decryptSecret(
    secret.value_ciphertext as Buffer,
    secret.nonce as Buffer
  )

  const creds = JSON.parse(plaintext) as S3Credentials
  if (!creds.accessKeyId || !creds.secretAccessKey) {
    throw new Error(
      "S3 credentials secret has unexpected format (expected { accessKeyId, secretAccessKey })"
    )
  }
  return creds
}

/** Resolve credentials and build one destination client for a request scope. */
export async function createBackupS3Probe(
  db: Db,
  config: S3BackedConfig
): Promise<BackupS3Probe> {
  const credentials = await resolveS3Credentials(db, config)
  return {
    credentials,
    client: createS3Client({
      ...(config.s3_endpoint ? { endpoint: config.s3_endpoint } : {}),
      region: config.s3_region ?? "auto",
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    }),
  }
}

export function buildBackupFilename(
  startedAt: Date,
  extension: string,
  encrypted: boolean
): string {
  const ts = startedAt.toISOString().replace(/[:.]/g, "-")
  return `${ts}.${extension}${encrypted ? ".age" : ""}`
}

function parseS3Location(location: string): { bucket: string; key: string } {
  const url = new URL(location)
  return {
    bucket: url.hostname,
    key: url.pathname.replace(/^\//, ""),
  }
}
