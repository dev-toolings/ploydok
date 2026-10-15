// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

/**
 * Storage provider presets. A preset only decides how the form asks for a
 * destination and how its endpoint is derived; the stored destination keeps
 * the resolved endpoint, so a renamed provider endpoint never rewrites the
 * location of an existing backup.
 */
export const STORAGE_PROVIDER_IDS = [
  "aws",
  "cloudflare-r2",
  "azure-blob",
  "gcs",
  "backblaze-b2",
  "wasabi",
  "digitalocean-spaces",
  "hetzner",
  "scaleway",
  "ovhcloud",
  "minio",
  "s3-compatible",
  "local",
] as const

export const StorageProviderIdSchema = z.enum(STORAGE_PROVIDER_IDS)
export type StorageProviderId = z.infer<typeof StorageProviderIdSchema>

export type StorageProviderKind = "s3" | "azure" | "local"

export interface StorageProvider {
  id: StorageProviderId
  kind: StorageProviderKind
  /** Endpoint template. `{region}` and `{account}` are replaced from the form. */
  endpointTemplate: string | null
  /** The user types the endpoint (self-hosted or unlisted providers). */
  customEndpoint: boolean
  /** The template needs an account identifier (R2 account ID, Azure account). */
  needsAccount: boolean
  regions: readonly string[]
  defaultRegion: string | null
  /** Where the user creates the keys this form asks for. */
  credentialsUrl: string | null
}

const provider = (value: StorageProvider): StorageProvider => value

export const STORAGE_PROVIDERS: Record<StorageProviderId, StorageProvider> = {
  aws: provider({
    id: "aws",
    kind: "s3",
    endpointTemplate: null,
    customEndpoint: false,
    needsAccount: false,
    regions: [
      "us-east-1",
      "us-east-2",
      "us-west-1",
      "us-west-2",
      "ca-central-1",
      "eu-west-1",
      "eu-west-2",
      "eu-west-3",
      "eu-central-1",
      "eu-central-2",
      "eu-north-1",
      "eu-south-1",
      "ap-south-1",
      "ap-southeast-1",
      "ap-southeast-2",
      "ap-northeast-1",
      "ap-northeast-2",
      "sa-east-1",
    ],
    defaultRegion: "eu-west-3",
    credentialsUrl:
      "https://console.aws.amazon.com/iam/home#/security_credentials",
  }),
  "cloudflare-r2": provider({
    id: "cloudflare-r2",
    kind: "s3",
    endpointTemplate: "https://{account}.r2.cloudflarestorage.com",
    customEndpoint: false,
    needsAccount: true,
    regions: [],
    defaultRegion: "auto",
    credentialsUrl: "https://dash.cloudflare.com/?to=/:account/r2/api-tokens",
  }),
  "azure-blob": provider({
    id: "azure-blob",
    kind: "azure",
    endpointTemplate: "https://{account}.blob.core.windows.net",
    customEndpoint: false,
    needsAccount: true,
    regions: [],
    defaultRegion: null,
    credentialsUrl:
      "https://portal.azure.com/#browse/Microsoft.Storage%2FStorageAccounts",
  }),
  gcs: provider({
    id: "gcs",
    kind: "s3",
    endpointTemplate: "https://storage.googleapis.com",
    customEndpoint: false,
    needsAccount: false,
    regions: [],
    defaultRegion: "auto",
    credentialsUrl:
      "https://console.cloud.google.com/storage/settings;tab=interoperability",
  }),
  "backblaze-b2": provider({
    id: "backblaze-b2",
    kind: "s3",
    endpointTemplate: "https://s3.{region}.backblazeb2.com",
    customEndpoint: false,
    needsAccount: false,
    regions: [
      "us-west-001",
      "us-west-002",
      "us-west-004",
      "us-east-005",
      "eu-central-003",
    ],
    defaultRegion: "eu-central-003",
    credentialsUrl: "https://secure.backblaze.com/app_keys.htm",
  }),
  wasabi: provider({
    id: "wasabi",
    kind: "s3",
    endpointTemplate: "https://s3.{region}.wasabisys.com",
    customEndpoint: false,
    needsAccount: false,
    regions: [
      "us-east-1",
      "us-east-2",
      "us-central-1",
      "us-west-1",
      "ca-central-1",
      "eu-central-1",
      "eu-central-2",
      "eu-west-1",
      "eu-west-2",
      "eu-west-3",
      "eu-south-1",
      "ap-northeast-1",
      "ap-northeast-2",
      "ap-southeast-1",
      "ap-southeast-2",
    ],
    defaultRegion: "eu-central-1",
    credentialsUrl: "https://console.wasabisys.com/access_keys",
  }),
  "digitalocean-spaces": provider({
    id: "digitalocean-spaces",
    kind: "s3",
    endpointTemplate: "https://{region}.digitaloceanspaces.com",
    customEndpoint: false,
    needsAccount: false,
    regions: [
      "nyc3",
      "sfo2",
      "sfo3",
      "ams3",
      "fra1",
      "lon1",
      "sgp1",
      "syd1",
      "blr1",
      "tor1",
      "atl1",
    ],
    defaultRegion: "fra1",
    credentialsUrl: "https://cloud.digitalocean.com/spaces/access_keys",
  }),
  hetzner: provider({
    id: "hetzner",
    kind: "s3",
    endpointTemplate: "https://{region}.your-objectstorage.com",
    customEndpoint: false,
    needsAccount: false,
    regions: ["fsn1", "nbg1", "hel1"],
    defaultRegion: "fsn1",
    credentialsUrl: "https://console.hetzner.cloud/",
  }),
  scaleway: provider({
    id: "scaleway",
    kind: "s3",
    endpointTemplate: "https://s3.{region}.scw.cloud",
    customEndpoint: false,
    needsAccount: false,
    regions: ["fr-par", "nl-ams", "pl-waw"],
    defaultRegion: "fr-par",
    credentialsUrl: "https://console.scaleway.com/iam/api-keys",
  }),
  ovhcloud: provider({
    id: "ovhcloud",
    kind: "s3",
    endpointTemplate: "https://s3.{region}.io.cloud.ovh.net",
    customEndpoint: false,
    needsAccount: false,
    regions: ["gra", "sbg", "rbx", "de", "uk", "waw", "bhs"],
    defaultRegion: "gra",
    credentialsUrl: "https://www.ovh.com/manager/#/public-cloud",
  }),
  minio: provider({
    id: "minio",
    kind: "s3",
    endpointTemplate: null,
    customEndpoint: true,
    needsAccount: false,
    regions: [],
    defaultRegion: "us-east-1",
    credentialsUrl: null,
  }),
  "s3-compatible": provider({
    id: "s3-compatible",
    kind: "s3",
    endpointTemplate: null,
    customEndpoint: true,
    needsAccount: false,
    regions: [],
    defaultRegion: "auto",
    credentialsUrl: null,
  }),
  local: provider({
    id: "local",
    kind: "local",
    endpointTemplate: null,
    customEndpoint: false,
    needsAccount: false,
    regions: [],
    defaultRegion: null,
    credentialsUrl: null,
  }),
}

/** R2 account IDs and Azure account names: a single DNS label. */
export const STORAGE_ACCOUNT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Resolve the endpoint of a preset, or `undefined` when the provider uses
 * the SDK default (AWS) or a typed endpoint. Returns null when a required
 * input is missing or malformed.
 */
export function buildStorageProviderEndpoint(
  providerId: StorageProviderId,
  input: { region?: string | null; account?: string | null }
): string | undefined | null {
  const preset = STORAGE_PROVIDERS[providerId]
  if (!preset.endpointTemplate) return undefined
  let endpoint = preset.endpointTemplate
  if (endpoint.includes("{account}")) {
    const account = input.account?.trim().toLowerCase() ?? ""
    if (!STORAGE_ACCOUNT_PATTERN.test(account)) return null
    endpoint = endpoint.replace("{account}", account)
  }
  if (endpoint.includes("{region}")) {
    const region = input.region?.trim() ?? ""
    if (!preset.regions.includes(region)) return null
    endpoint = endpoint.replace("{region}", region)
  }
  return endpoint
}

/** Recover the account part of a preset endpoint, for the edit form. */
export function storageProviderAccount(
  providerId: StorageProviderId,
  endpoint: string | null
): string {
  const template = STORAGE_PROVIDERS[providerId].endpointTemplate
  if (!template?.includes("{account}") || !endpoint) return ""
  const [prefix = "", suffix = ""] = template.split("{account}")
  if (!endpoint.startsWith(prefix) || !endpoint.endsWith(suffix)) return ""
  return endpoint.slice(prefix.length, endpoint.length - suffix.length)
}

/**
 * Best-effort provider for destinations created before presets existed.
 * Only used for display and to preselect the edit form.
 */
export function detectStorageProvider(
  kind: StorageProviderKind,
  endpoint: string | null
): StorageProviderId {
  if (kind === "local") return "local"
  if (kind === "azure") return "azure-blob"
  if (!endpoint) return "aws"
  let host: string
  try {
    host = new URL(endpoint).hostname.toLowerCase()
  } catch {
    return "s3-compatible"
  }
  const suffixes: Array<[string, StorageProviderId]> = [
    [".r2.cloudflarestorage.com", "cloudflare-r2"],
    ["storage.googleapis.com", "gcs"],
    [".backblazeb2.com", "backblaze-b2"],
    [".wasabisys.com", "wasabi"],
    [".digitaloceanspaces.com", "digitalocean-spaces"],
    [".your-objectstorage.com", "hetzner"],
    [".scw.cloud", "scaleway"],
    [".cloud.ovh.net", "ovhcloud"],
    [".amazonaws.com", "aws"],
  ]
  for (const [suffix, id] of suffixes) {
    if (host === suffix.replace(/^\./, "") || host.endsWith(suffix)) return id
  }
  return "s3-compatible"
}

export interface AzureConnectionString {
  accountName: string
  accountKey: string
  endpoint: string | null
}

/**
 * Parse an Azure storage connection string, as copied from the portal's
 * "Access keys" blade. Lets the user paste one value instead of three.
 */
export function parseAzureConnectionString(
  value: string
): AzureConnectionString | null {
  const parts = new Map<string, string>()
  for (const segment of value.trim().split(";")) {
    const index = segment.indexOf("=")
    if (index <= 0) continue
    parts.set(
      segment.slice(0, index).trim().toLowerCase(),
      segment.slice(index + 1).trim()
    )
  }
  const accountName = parts.get("accountname")
  const accountKey = parts.get("accountkey")
  if (!accountName || !accountKey) return null
  const blobEndpoint = parts.get("blobendpoint")
  const suffix = parts.get("endpointsuffix")
  const protocol = parts.get("defaultendpointsprotocol") ?? "https"
  const endpoint = blobEndpoint
    ? blobEndpoint.replace(/\/$/, "")
    : suffix && suffix !== "core.windows.net"
      ? `${protocol}://${accountName}.blob.${suffix}`
      : null
  return { accountName, accountKey, endpoint }
}
