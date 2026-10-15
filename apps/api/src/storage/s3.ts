// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lightweight S3/R2/MinIO wrapper.
 *
 * Supports any S3-compatible endpoint. All operations are streaming-friendly.
 * Multipart upload is handled transparently by @aws-sdk/lib-storage.
 */
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import type { Readable } from "node:stream"

export interface S3Config {
  endpoint?: string | undefined
  region: string
  accessKeyId: string
  secretAccessKey: string
}

const CHUNK_SIZE = 5 * 1024 * 1024 // S3 multipart minimum: 5 MiB

export function createS3Client(config: S3Config): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  }
  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint
    // Required for path-style access (MinIO, LocalStack, R2)
    clientConfig.forcePathStyle = true
  }
  return new S3Client(clientConfig)
}

/**
 * Upload a readable stream to S3 using multipart upload.
 * Returns the final S3 key.
 */
export async function uploadStream(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable | ReadableStream,
): Promise<{ key: string }> {
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
    },
    partSize: CHUNK_SIZE,
    queueSize: 2,
  })
  await upload.done()
  return { key }
}

/**
 * Download an object from S3 as a Node.js Readable stream.
 */
export async function downloadStream(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Readable> {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key })
  const res = await client.send(cmd)
  if (!res.Body) throw new Error(`S3 object ${bucket}/${key} returned empty body`)
  return res.Body as Readable
}

/**
 * List objects in a bucket under a given prefix.
 */
export async function listObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<Array<{ key: string; size: number; lastModified: Date | undefined }>> {
  const cmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
  const res = await client.send(cmd)
  return (res.Contents ?? []).map((obj) => ({
    key: obj.Key ?? "",
    size: obj.Size ?? 0,
    lastModified: obj.LastModified,
  }))
}

/**
 * Delete a single object from S3.
 */
export async function deleteObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  const cmd = new DeleteObjectCommand({ Bucket: bucket, Key: key })
  await client.send(cmd)
}
