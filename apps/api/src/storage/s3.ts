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
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { lookup as dnsLookup } from "node:dns"
import { Agent as HttpAgent } from "node:http"
import { Agent as HttpsAgent } from "node:https"
import type { LookupFunction } from "node:net"
import type { Readable } from "node:stream"
import {
  isUnsafeStorageDestinationAddress,
  isUnsafeStorageDestinationEndpoint,
} from "@ploydok/shared"
import { S3_LINK_LOCAL_ENDPOINT_ERROR } from "./endpoint-guard"

export interface S3Config {
  endpoint?: string | undefined
  region: string
  accessKeyId: string
  secretAccessKey: string
}

const CHUNK_SIZE = 5 * 1024 * 1024 // S3 multipart minimum: 5 MiB

export { S3_LINK_LOCAL_ENDPOINT_ERROR }

type LookupAll = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: S3LookupAddress[]
  ) => void
) => void

type S3LookupAddress = { address: string; family: number }

const defaultLookup = dnsLookup as unknown as LookupAll

function blockedEndpointError(): NodeJS.ErrnoException {
  const error = new Error(S3_LINK_LOCAL_ENDPOINT_ERROR) as NodeJS.ErrnoException
  error.code = "EHOSTUNREACH"
  return error
}

/**
 * Resolve every address before opening an S3 socket. Rejecting the complete
 * answer when one address is link-local prevents DNS aliases and a later
 * connection attempt from reaching the instance metadata network.
 */
export function createSafeS3Lookup(
  resolver: LookupAll = defaultLookup
): LookupFunction {
  return (hostname, options, callback) => {
    const returnAll = options.all === true
    const fail = (error: NodeJS.ErrnoException) => {
      if (returnAll) callback(error, [])
      else callback(error, "", 0)
    }

    if (isUnsafeStorageDestinationAddress(hostname)) {
      fail(blockedEndpointError())
      return
    }

    resolver(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        fail(error)
        return
      }
      if (
        addresses.some((address) =>
          isUnsafeStorageDestinationAddress(address.address)
        )
      ) {
        fail(blockedEndpointError())
        return
      }
      const family =
        options.family === "IPv4"
          ? 4
          : options.family === "IPv6"
            ? 6
            : options.family
      const matchingAddresses =
        family === 4 || family === 6
          ? addresses.filter((address) => address.family === family)
          : addresses
      if (matchingAddresses.length === 0) {
        const notFound = new Error(
          `S3 endpoint host could not be resolved: ${hostname}`
        ) as NodeJS.ErrnoException
        notFound.code = "ENOTFOUND"
        fail(notFound)
        return
      }
      if (returnAll) {
        callback(null, matchingAddresses)
      } else {
        const address = matchingAddresses[0]!
        callback(null, address.address, address.family)
      }
    })
  }
}

export function createS3Client(config: S3Config): S3Client {
  if (config.endpoint && isUnsafeStorageDestinationEndpoint(config.endpoint)) {
    throw blockedEndpointError()
  }

  const safeLookup = createSafeS3Lookup()
  const clientConfig: S3ClientConfig = {
    region: config.region,
    // Some S3-compatible stores reject the SDK's optional CRC32 request metadata.
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestHandler: {
      httpAgent: new HttpAgent({ lookup: safeLookup }),
      httpsAgent: new HttpsAgent({ lookup: safeLookup }),
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
  abortSignal?: AbortSignal,
): Promise<Readable> {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key })
  const res = await client.send(cmd, abortSignal ? { abortSignal } : undefined)
  if (!res.Body) throw new Error(`S3 object ${bucket}/${key} returned empty body`)
  return res.Body as Readable
}

/** Read metadata for one object without downloading its contents. */
export async function headObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<{ size: number; lastModified: Date | undefined }> {
  const res = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: AbortSignal.timeout(5_000) }
  )
  return {
    size: res.ContentLength ?? 0,
    lastModified: res.LastModified,
  }
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
  abortSignal?: AbortSignal,
): Promise<void> {
  const cmd = new DeleteObjectCommand({ Bucket: bucket, Key: key })
  await client.send(cmd, abortSignal ? { abortSignal } : undefined)
}

/** Upload a bounded witness object with caller-controlled cancellation. */
export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: string | Uint8Array,
  abortSignal?: AbortSignal,
): Promise<void> {
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, Body: body })
  await client.send(cmd, abortSignal ? { abortSignal } : undefined)
}
