// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import {
  projects,
  secrets,
  users,
  storage_destinations,
  type Db,
} from "@ploydok/db"
import { resolveBackupDestination } from "./storage"
import type { BackupDestinationConfig } from "./storage"
import { makeTestDb, TEST_PG_URL } from "../test/db-helpers"

const skip = !TEST_PG_URL

describe.skipIf(skip)("shared backup destination resolution", () => {
  let db: Db
  const orgIds: string[] = []

  afterEach(async () => {
    for (const orgId of orgIds.splice(0)) {
      await db.delete(projects).where(eq(projects.id, orgId))
    }
  })

  it("uses one workspace destination for database and volume configs while preserving each prefix", async () => {
    ;({ db } = await makeTestDb())
    const orgId = `resolve-org-${crypto.randomUUID().slice(0, 8)}`
    orgIds.push(orgId)
    const ownerId = `resolve-owner-${crypto.randomUUID().slice(0, 8)}`
    const now = new Date()

    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@test.invalid`,
      display_name: "Resolution Owner",
      created_at: now,
      updated_at: now,
    })
    await db.insert(projects).values({
      id: orgId,
      owner_id: ownerId,
      name: "Resolution Workspace",
      slug: orgId,
      created_at: now,
    })
    const credentialId = `resolve-credentials-${crypto.randomUUID().slice(0, 8)}`
    await db.insert(secrets).values({
      id: credentialId,
      app_id: null,
      project_id: orgId,
      scope: "shared",
      phase: "runtime",
      key: `storage-destination:${credentialId}`,
      value_ciphertext: Buffer.from("ciphertext"),
      nonce: Buffer.from("nonce"),
      linked_database_id: null,
      created_at: now,
    })
    const destinationId = `resolve-destination-${crypto.randomUUID().slice(0, 8)}`
    await db.insert(storage_destinations).values({
      id: destinationId,
      org_id: orgId,
      name: "Shared R2",
      kind: "s3",
      s3_endpoint: "https://new-endpoint.example.test",
      s3_bucket: "shared-backups",
      s3_region: "auto",
      credentials_secret_id: credentialId,
      last_test_at: null,
      last_test_status: null,
      last_test_error: null,
      created_at: now,
      updated_at: now,
    })

    const databaseInput: BackupDestinationConfig = {
      destination_id: destinationId,
      destination_kind: "local",
      s3_endpoint: "https://stale-inline-endpoint.example.test",
      s3_bucket: "stale-inline-bucket",
      s3_prefix: "database/tenant-a",
      s3_region: "stale-region",
      s3_credentials_secret_id: "stale-inline-secret",
    }
    const volumeInput: BackupDestinationConfig = {
      destination_id: destinationId,
      destination_kind: "local",
      s3_endpoint: null,
      s3_bucket: null,
      s3_prefix: "volume/tenant-a",
      s3_region: null,
      s3_credentials_secret_id: null,
    }
    const databaseConfig = await resolveBackupDestination(db, databaseInput)
    const volumeConfig = await resolveBackupDestination(db, volumeInput)

    for (const config of [databaseConfig, volumeConfig]) {
      expect(config.destination_id).toBe(destinationId)
      expect(config.destination_kind).toBe("s3")
      expect(config.s3_endpoint).toBe("https://new-endpoint.example.test")
      expect(config.s3_bucket).toBe("shared-backups")
      expect(config.s3_region).toBe("auto")
      expect(config.s3_credentials_secret_id).toBe(credentialId)
    }
    expect(databaseConfig.s3_prefix).toBe("database/tenant-a")
    expect(volumeConfig.s3_prefix).toBe("volume/tenant-a")
  })
})
