// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, mock } from "bun:test"
import {
  secrets,
  storage_destinations,
  type Db,
} from "@ploydok/db"
import type { S3Client } from "@aws-sdk/client-s3"

const decryptSecret = mock(async () =>
  JSON.stringify({ accessKeyId: "resolved-access", secretAccessKey: "resolved-secret" })
)
const createS3Client = mock((_config: unknown) => ({}) as S3Client)

mock.module("../secrets/crypto", () => ({ decryptSecret }))
mock.module("../storage/s3", () => ({
  createS3Client,
  deleteObject: mock(async () => undefined),
  downloadStream: mock(async () => {
    throw new Error("downloadStream is not used by resolver tests")
  }),
  headObject: mock(async () => ({ size: 0, lastModified: new Date() })),
  putObject: mock(async () => undefined),
  uploadStream: mock(async () => ({ key: "backup" })),
}))

const {
  createBackupS3Probe,
  resolveBackupDestination,
  resolveS3Credentials,
} = await import("./storage")

const destination = {
  id: "destination-shared",
  org_id: "org-shared",
  name: "Shared destination",
  kind: "s3" as const,
  s3_endpoint: "https://central.example.test",
  s3_bucket: "central-backups",
  s3_region: "auto",
  credentials_secret_id: "secret-central",
  last_test_at: null,
  last_test_status: null,
  last_test_error: null,
  created_at: new Date("2026-10-15T10:00:00.000Z"),
  updated_at: new Date("2026-10-15T10:01:00.000Z"),
}

const secret = {
  id: "secret-central",
  app_id: null,
  project_id: "org-shared",
  scope: "shared" as const,
  phase: "runtime" as const,
  key: "storage-destination:destination-shared",
  value_ciphertext: Buffer.from("ciphertext"),
  nonce: Buffer.from("nonce"),
  linked_database_id: null,
  created_at: new Date("2026-10-15T10:00:00.000Z"),
}

function fakeDb(options: {
  destination?: typeof destination
  secret?: typeof secret
} = {}) {
  const select = mock(() => {
    let table: unknown
    const chain = {
      from(value: unknown) {
        table = value
        return chain
      },
      where() {
        return chain
      },
      async limit() {
        if (table === storage_destinations) {
          return options.destination ? [options.destination] : []
        }
        if (table === secrets) {
          return options.secret ? [options.secret] : []
        }
        throw new Error("unexpected table in storage test fixture")
      },
    }
    return chain
  })
  return { db: { select } as unknown as Db, select }
}

describe("shared backup storage resolution", () => {
  beforeEach(() => {
    decryptSecret.mockReset()
    decryptSecret.mockResolvedValue(
      JSON.stringify({ accessKeyId: "resolved-access", secretAccessKey: "resolved-secret" })
    )
    createS3Client.mockReset()
    createS3Client.mockReturnValue({} as S3Client)
  })

  it("uses workspace destination fields while preserving the backup prefix", async () => {
    const { db } = fakeDb({ destination })
    const resolved = await resolveBackupDestination(db, {
      destination_id: destination.id,
      destination_kind: "local",
      s3_endpoint: "https://stale-inline.example.test",
      s3_bucket: "stale-inline-bucket",
      s3_prefix: "database/tenant-a",
      s3_region: "stale-region",
      s3_credentials_secret_id: "stale-secret",
    })

    expect(resolved).toMatchObject({
      destination_id: destination.id,
      destination_kind: "s3",
      destination_updated_at: destination.updated_at,
      s3_endpoint: destination.s3_endpoint,
      s3_bucket: destination.s3_bucket,
      s3_prefix: "database/tenant-a",
      s3_region: destination.s3_region,
      s3_credentials_secret_id: destination.credentials_secret_id,
    })
  })

  it("keeps legacy inline fields when a linked destination is missing", async () => {
    const { db } = fakeDb()
    const resolved = await resolveBackupDestination(db, {
      destination_id: "deleted-destination",
      destination_kind: "s3",
      s3_endpoint: "https://legacy.example.test",
      s3_bucket: "legacy-bucket",
      s3_prefix: "legacy/prefix",
      s3_region: "legacy-region",
      s3_credentials_secret_id: "legacy-secret",
    })

    expect(resolved).toEqual({
      destination_id: "deleted-destination",
      destination_updated_at: null,
      destination_kind: "s3",
      s3_endpoint: "https://legacy.example.test",
      s3_bucket: "legacy-bucket",
      s3_prefix: "legacy/prefix",
      s3_region: "legacy-region",
      s3_credentials_secret_id: "legacy-secret",
    })
  })

  it("resolves encrypted credentials and builds a probe from the workspace destination", async () => {
    const { db, select } = fakeDb({ destination, secret })
    const probe = await createBackupS3Probe(db, {
      destination_id: destination.id,
      destination_kind: "local",
      s3_endpoint: "https://stale-inline.example.test",
      s3_bucket: "stale-inline-bucket",
      s3_prefix: "database/tenant-a",
      s3_region: "stale-region",
      s3_credentials_secret_id: "stale-secret",
    })

    expect(probe.credentials).toEqual({
      accessKeyId: "resolved-access",
      secretAccessKey: "resolved-secret",
    })
    expect(createS3Client).toHaveBeenCalledWith({
      endpoint: destination.s3_endpoint,
      region: destination.s3_region,
      accessKeyId: "resolved-access",
      secretAccessKey: "resolved-secret",
    })
    expect(decryptSecret).toHaveBeenCalledWith(
      secret.value_ciphertext,
      secret.nonce
    )
    expect(select).toHaveBeenCalled()
  })

  it("rejects an encrypted secret that does not contain both S3 keys", async () => {
    decryptSecret.mockResolvedValue(JSON.stringify({ accessKeyId: "only-one-key" }))
    const { db } = fakeDb({ secret })

    await expect(
      resolveS3Credentials(db, {
        destination_kind: "s3",
        s3_endpoint: "https://legacy.example.test",
        s3_bucket: "legacy-bucket",
        s3_prefix: "legacy/prefix",
        s3_region: "auto",
        s3_credentials_secret_id: secret.id,
      })
    ).rejects.toThrow("expected { accessKeyId, secretAccessKey }")
  })
})
