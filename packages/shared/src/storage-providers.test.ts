// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {
  buildStorageProviderEndpoint,
  detectStorageProvider,
  parseAzureConnectionString,
  STORAGE_PROVIDERS,
  storageProviderAccount,
} from "./storage-providers"
import { CreateStorageDestinationSchema } from "./storage-destinations"

describe("storage provider presets", () => {
  it("derives endpoints from the region or the account", () => {
    expect(
      buildStorageProviderEndpoint("aws", { region: "eu-west-3" })
    ).toBeUndefined()
    expect(
      buildStorageProviderEndpoint("cloudflare-r2", { account: "ABC123def" })
    ).toBe("https://abc123def.r2.cloudflarestorage.com")
    expect(buildStorageProviderEndpoint("hetzner", { region: "nbg1" })).toBe(
      "https://nbg1.your-objectstorage.com"
    )
    expect(
      buildStorageProviderEndpoint("azure-blob", { account: "backups01" })
    ).toBe("https://backups01.blob.core.windows.net")
    expect(
      buildStorageProviderEndpoint("wasabi", { region: "mars-1" })
    ).toBeNull()
    expect(
      buildStorageProviderEndpoint("cloudflare-r2", { account: "a.b" })
    ).toBeNull()
  })

  it("detects every preset back from its own endpoint", () => {
    for (const preset of Object.values(STORAGE_PROVIDERS)) {
      if (!preset.endpointTemplate) continue
      const endpoint = buildStorageProviderEndpoint(preset.id, {
        account: "acct",
        region: preset.regions[0] ?? null,
      })
      expect(detectStorageProvider(preset.kind, endpoint ?? null)).toBe(
        preset.id
      )
      expect(storageProviderAccount(preset.id, endpoint ?? null)).toBe(
        preset.needsAccount ? "acct" : ""
      )
    }
    expect(detectStorageProvider("s3", null)).toBe("aws")
    expect(detectStorageProvider("s3", "http://10.0.0.8:9000")).toBe(
      "s3-compatible"
    )
  })

  it("parses an Azure connection string copied from the portal", () => {
    expect(
      parseAzureConnectionString(
        "DefaultEndpointsProtocol=https;AccountName=backups01;AccountKey=a2V5PT0=;EndpointSuffix=core.windows.net"
      )
    ).toEqual({
      accountName: "backups01",
      accountKey: "a2V5PT0=",
      endpoint: null,
    })
    expect(
      parseAzureConnectionString(
        "AccountName=devstoreaccount1;AccountKey=k==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1/"
      )?.endpoint
    ).toBe("http://127.0.0.1:10000/devstoreaccount1")
    expect(parseAzureConnectionString("AccountName=only")).toBeNull()
  })

  it("requires Azure credentials for an Azure destination", () => {
    const base = {
      name: "Azure",
      kind: "azure",
      provider: "azure-blob",
      bucket: "backups",
    }
    expect(
      CreateStorageDestinationSchema.safeParse({
        ...base,
        credentials: { accountName: "backups01", accountKey: "key" },
      }).success
    ).toBe(true)
    expect(
      CreateStorageDestinationSchema.safeParse({
        ...base,
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
      }).success
    ).toBe(false)
    expect(
      CreateStorageDestinationSchema.safeParse({
        ...base,
        provider: "aws",
        credentials: { accountName: "backups01", accountKey: "key" },
      }).success
    ).toBe(false)
  })
})
