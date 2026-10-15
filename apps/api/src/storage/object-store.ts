// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One object storage interface over the S3 protocol and Azure Blob Storage.
 * Backup code addresses artifacts as `s3://bucket/key` or
 * `azure://container/key` and never needs to know which SDK is behind them.
 */
import {
  CreateBucketCommand,
  HeadBucketCommand,
  type BucketLocationConstraint,
  type S3Client,
} from "@aws-sdk/client-s3"
import type { ContainerClient } from "@azure/storage-blob"
import type { Readable } from "node:stream"
import {
  createS3Client,
  deleteObject,
  downloadStream,
  headObject,
  putObject,
  uploadStream,
} from "./s3"
import { S3_LINK_LOCAL_ENDPOINT_ERROR } from "./endpoint-guard"
import {
  azureDelete,
  azureDownload,
  azureHead,
  azurePut,
  azureUpload,
  createAzureContainerClient,
} from "./azure"

export type ObjectStoreScheme = "s3" | "azure"

export type ObjectStoreCredentials =
  | { accessKeyId: string; secretAccessKey: string }
  | { accountName: string; accountKey: string }

export interface ObjectStoreConfig {
  kind: ObjectStoreScheme
  endpoint: string | null
  bucket: string
  region: string | null
  credentials: ObjectStoreCredentials
}

export interface ObjectMetadata {
  size: number
  lastModified: Date | undefined
}

export interface ObjectStore {
  readonly scheme: ObjectStoreScheme
  readonly bucket: string
  upload(key: string, body: Readable): Promise<void>
  put(key: string, body: string, abortSignal?: AbortSignal): Promise<void>
  download(key: string, abortSignal?: AbortSignal): Promise<Readable>
  head(key: string): Promise<ObjectMetadata>
  delete(key: string, abortSignal?: AbortSignal): Promise<void>
  /** Create the bucket or container when it does not exist yet. */
  ensureBucket(abortSignal?: AbortSignal): Promise<"exists" | "created">
  close(): void
}

export const AZURE_DEFAULT_ENDPOINT_SUFFIX = ".blob.core.windows.net"

export function isRemoteLocation(location: string): boolean {
  return location.startsWith("s3://") || location.startsWith("azure://")
}

export function buildRemoteLocation(
  scheme: ObjectStoreScheme,
  bucket: string,
  key: string
): string {
  return `${scheme}://${bucket}/${key}`
}

export function parseRemoteLocation(
  location: string
): { scheme: ObjectStoreScheme; bucket: string; key: string } {
  const url = new URL(location)
  const scheme = url.protocol.replace(/:$/, "")
  if (scheme !== "s3" && scheme !== "azure") {
    throw new Error(`Unsupported backup location scheme: ${url.protocol}`)
  }
  return {
    scheme,
    bucket: url.hostname,
    key: url.pathname.replace(/^\//, ""),
  }
}

export async function openObjectStore(
  config: ObjectStoreConfig
): Promise<ObjectStore> {
  if (config.kind === "azure") {
    if (!("accountKey" in config.credentials)) {
      throw new Error("Azure destination credentials have an unexpected format")
    }
    const endpoint =
      config.endpoint ??
      `https://${config.credentials.accountName}${AZURE_DEFAULT_ENDPOINT_SUFFIX}`
    const container = await createAzureContainerClient(
      {
        endpoint,
        accountName: config.credentials.accountName,
        accountKey: config.credentials.accountKey,
      },
      config.bucket
    )
    return azureStore(container)
  }
  if (!("secretAccessKey" in config.credentials)) {
    throw new Error("S3 destination credentials have an unexpected format")
  }
  const client = createS3Client({
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    region: config.region ?? "auto",
    accessKeyId: config.credentials.accessKeyId,
    secretAccessKey: config.credentials.secretAccessKey,
  })
  return s3Store(client, config.bucket, config.region, !config.endpoint)
}

function s3Store(
  client: S3Client,
  bucket: string,
  region: string | null,
  isAws: boolean
): ObjectStore {
  return {
    scheme: "s3",
    bucket,
    upload: async (key, body) => {
      await uploadStream(client, bucket, key, body)
    },
    put: (key, body, signal) => putObject(client, bucket, key, body, signal),
    download: (key, signal) => downloadStream(client, bucket, key, signal),
    head: (key) => headObject(client, bucket, key),
    delete: (key, signal) => deleteObject(client, bucket, key, signal),
    ensureBucket: async (signal) => {
      try {
        await client.send(
          new HeadBucketCommand({ Bucket: bucket }),
          signal ? { abortSignal: signal } : undefined
        )
        return "exists"
      } catch (error) {
        if (classifyStorageError(error) !== "bucket_not_found") throw error
      }
      // AWS rejects an explicit us-east-1 constraint; other providers infer
      // the location from their endpoint.
      const constraint =
        isAws && region && region !== "us-east-1" && region !== "auto"
          ? { LocationConstraint: region as BucketLocationConstraint }
          : undefined
      await client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ...(constraint ? { CreateBucketConfiguration: constraint } : {}),
        }),
        signal ? { abortSignal: signal } : undefined
      )
      return "created"
    },
    close: () => client.destroy(),
  }
}

function azureStore(container: ContainerClient): ObjectStore {
  return {
    scheme: "azure",
    bucket: container.containerName,
    upload: (key, body) => azureUpload(container, key, body),
    put: (key, body, signal) => azurePut(container, key, body, signal),
    download: (key, signal) => azureDownload(container, key, signal),
    head: (key) => azureHead(container, key),
    delete: (key, signal) => azureDelete(container, key, signal),
    ensureBucket: async (signal) => {
      const result = await container.createIfNotExists(
        signal ? { abortSignal: signal } : {}
      )
      return result.succeeded ? "created" : "exists"
    },
    close: () => {},
  }
}

/**
 * Stable reasons a destination check can fail. They are safe to store and to
 * show: provider messages can echo endpoints or key identifiers.
 */
export type StorageFailureReason =
  | "auth_failed"
  | "bucket_not_found"
  | "endpoint_unreachable"
  | "endpoint_blocked"
  | "timeout"
  | "unknown"

type ProviderError = {
  name?: string
  code?: string
  Code?: string
  statusCode?: number
  message?: string
  $metadata?: { httpStatusCode?: number }
}

export function isMissingObjectError(error: unknown): boolean {
  const candidate = error as ProviderError | undefined
  return (
    candidate?.$metadata?.httpStatusCode === 404 ||
    candidate?.statusCode === 404 ||
    candidate?.name === "NotFound" ||
    candidate?.name === "NoSuchKey" ||
    candidate?.Code === "NotFound" ||
    candidate?.Code === "NoSuchKey" ||
    candidate?.code === "BlobNotFound"
  )
}

export function classifyStorageError(error: unknown): StorageFailureReason {
  const candidate = (error ?? {}) as ProviderError
  const name = candidate.name ?? ""
  const code = candidate.Code ?? candidate.code ?? ""
  const status = candidate.$metadata?.httpStatusCode ?? candidate.statusCode
  if (candidate.message === S3_LINK_LOCAL_ENDPOINT_ERROR) return "endpoint_blocked"
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED"
  ) {
    return "timeout"
  }
  if (
    ["NoSuchBucket", "ContainerNotFound"].includes(name) ||
    ["NoSuchBucket", "ContainerNotFound"].includes(code) ||
    (name === "NotFound" && status === 404)
  ) {
    return "bucket_not_found"
  }
  if (
    status === 401 ||
    status === 403 ||
    [
      "InvalidAccessKeyId",
      "SignatureDoesNotMatch",
      "AccessDenied",
      "AuthenticationFailed",
      "AuthorizationFailure",
      "InvalidToken",
      "Forbidden",
    ].some((value) => value === name || value === code)
  ) {
    return "auth_failed"
  }
  if (
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "REQUEST_SEND_ERROR",
    ].includes(code)
  ) {
    return "endpoint_unreachable"
  }
  return "unknown"
}
