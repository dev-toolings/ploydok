// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Azure Blob Storage client. Azure does not speak the S3 protocol, so this is
 * the native path for Azure destinations.
 */
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  type ContainerClient,
} from "@azure/storage-blob"
import { lookup as dnsLookup } from "node:dns/promises"
import type { Readable } from "node:stream"
import { isUnsafeStorageDestinationAddress } from "@ploydok/shared"
import { S3_LINK_LOCAL_ENDPOINT_ERROR } from "./endpoint-guard"

export interface AzureConfig {
  endpoint: string
  accountName: string
  accountKey: string
}

const BLOCK_SIZE = 8 * 1024 * 1024

/**
 * The Azure SDK owns its HTTP agent, so the endpoint host is resolved and
 * checked before the client is built. Default endpoints are Microsoft hosts;
 * this mainly guards custom endpoints (Azurite, sovereign clouds).
 */
export async function assertSafeAzureEndpoint(endpoint: string): Promise<void> {
  const host = new URL(endpoint).hostname
  if (isUnsafeStorageDestinationAddress(host)) {
    throw new Error(S3_LINK_LOCAL_ENDPOINT_ERROR)
  }
  const addresses = await dnsLookup(host, { all: true, verbatim: true })
  if (addresses.some((entry) => isUnsafeStorageDestinationAddress(entry.address))) {
    throw new Error(S3_LINK_LOCAL_ENDPOINT_ERROR)
  }
}

export async function createAzureContainerClient(
  config: AzureConfig,
  container: string
): Promise<ContainerClient> {
  await assertSafeAzureEndpoint(config.endpoint)
  const service = new BlobServiceClient(
    config.endpoint,
    new StorageSharedKeyCredential(config.accountName, config.accountKey)
  )
  return service.getContainerClient(container)
}

export async function azureUpload(
  container: ContainerClient,
  key: string,
  body: Readable
): Promise<void> {
  await container.getBlockBlobClient(key).uploadStream(body, BLOCK_SIZE, 2)
}

export async function azurePut(
  container: ContainerClient,
  key: string,
  body: string,
  abortSignal?: AbortSignal
): Promise<void> {
  await container
    .getBlockBlobClient(key)
    .upload(body, Buffer.byteLength(body), abortSignal ? { abortSignal } : {})
}

export async function azureDownload(
  container: ContainerClient,
  key: string,
  abortSignal?: AbortSignal
): Promise<Readable> {
  const response = await container
    .getBlobClient(key)
    .download(0, undefined, abortSignal ? { abortSignal } : {})
  if (!response.readableStreamBody) {
    throw new Error(`Azure blob ${container.containerName}/${key} returned empty body`)
  }
  return response.readableStreamBody as Readable
}

export async function azureHead(
  container: ContainerClient,
  key: string
): Promise<{ size: number; lastModified: Date | undefined }> {
  const properties = await container
    .getBlobClient(key)
    .getProperties({ abortSignal: AbortSignal.timeout(5_000) })
  return {
    size: properties.contentLength ?? 0,
    lastModified: properties.lastModified,
  }
}

export async function azureDelete(
  container: ContainerClient,
  key: string,
  abortSignal?: AbortSignal
): Promise<void> {
  await container
    .getBlobClient(key)
    .deleteIfExists(abortSignal ? { abortSignal } : {})
}
