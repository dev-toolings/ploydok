// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "bun:test"
import { eq, sql } from "drizzle-orm"
import {
  apps,
  app_volumes,
  backup_configs,
  createDb,
  databases,
  projects,
  secrets,
  storage_destinations,
  users,
  volume_backup_configs,
} from "@ploydok/db"
import { backfillStorageDestinations } from "./storage-destinations-backfill"

const testPgUrl = Bun.env.PLOYDOK_TEST_PG_URL
const skip = !testPgUrl
const fixtureMasterKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
const sharedCiphertext = Buffer.from(
  "0e62a20919ec0b8e29d39dcfdf0d464bcf0d8d296a8218576cd674c38ccd8bcef34dc42f9f0fad802bf79f0dd70db95ad8769356d3cc18eb48571d1e3cbece2cb5da7db8141762e20becfbf878148c221e",
  "hex"
)
const sharedVolumeCiphertext = Buffer.from(
  "3fda6d8e5b16b156cf99a336cedaeef899107479ed4d00af2262da8a3ed8f28d876048a125d96fafdefb7006fb8b583b680712e7fe5963660c7614b32af77d3cbdf5b174f75353f41db6ab987551cf6212",
  "hex"
)
const sharedNonce = Buffer.from("010101010101010101010101", "hex")

describe.skipIf(skip)("storage destination legacy backfill", () => {
  const orgIds: string[] = []

  afterEach(async () => {
    if (!testPgUrl) return
    const db = createDb(testPgUrl)
    for (const orgId of orgIds.splice(0)) {
      await db.delete(projects).where(eq(projects.id, orgId))
    }
  })

  it("deduplicates migrated configs per workspace and leaves user-created duplicates distinct", async () => {
    const db = createDb(testPgUrl!)
    const suffix = crypto.randomUUID().slice(0, 8)
    const ownerA = `backfill-owner-a-${suffix}`
    const ownerB = `backfill-owner-b-${suffix}`
    const orgA = `backfill-org-a-${suffix}`
    const orgB = `backfill-org-b-${suffix}`
    orgIds.push(orgA, orgB)
    const databaseA = `backfill-db-a-${suffix}`
    const databaseB = `backfill-db-b-${suffix}`
    const appA = `backfill-app-a-${suffix}`
    const volumeA = `backfill-volume-a-${suffix}`
    const now = new Date()

    await db.insert(users).values([
      {
        id: ownerA,
        email: `${ownerA}@test.invalid`,
        display_name: "Backfill Owner A",
        created_at: now,
        updated_at: now,
      },
      {
        id: ownerB,
        email: `${ownerB}@test.invalid`,
        display_name: "Backfill Owner B",
        created_at: now,
        updated_at: now,
      },
    ])
    await db.insert(projects).values([
      {
        id: orgA,
        owner_id: ownerA,
        name: "Backfill Workspace A",
        slug: orgA,
        created_at: now,
      },
      {
        id: orgB,
        owner_id: ownerB,
        name: "Backfill Workspace B",
        slug: orgB,
        created_at: now,
      },
    ])
    await db.insert(databases).values([
      {
        id: databaseA,
        project_id: orgA,
        kind: "postgres",
        name: "Backfill database A",
        plan: "small",
        volume_name: `${databaseA}-volume`,
        created_at: now,
      },
      {
        id: databaseB,
        project_id: orgB,
        kind: "postgres",
        name: "Backfill database B",
        plan: "small",
        volume_name: `${databaseB}-volume`,
        created_at: now,
      },
    ])
    await db.insert(apps).values({
      id: appA,
      project_id: orgA,
      name: "Backfill app A",
      slug: appA,
      created_at: now,
      updated_at: now,
    })
    await db.insert(app_volumes).values({
      id: volumeA,
      app_id: appA,
      name: "data",
      mount_path: "/data",
      created_at: now,
    })

    const secretDbA = `backfill-secret-db-a-${suffix}`
    const secretVolumeA = `backfill-secret-volume-a-${suffix}`
    const secretDbB = `backfill-secret-db-b-${suffix}`
    await db.insert(secrets).values([
      {
        id: secretDbA,
        app_id: null,
        project_id: orgA,
        scope: "shared",
        phase: "runtime",
        key: "legacy-db-a",
        value_ciphertext: sharedCiphertext,
        nonce: sharedNonce,
        linked_database_id: databaseA,
        created_at: now,
      },
      {
        id: secretVolumeA,
        app_id: null,
        project_id: orgA,
        scope: "shared",
        phase: "runtime",
        key: "legacy-volume-a",
        value_ciphertext: sharedVolumeCiphertext,
        nonce: Buffer.from("020202020202020202020202", "hex"),
        linked_database_id: databaseA,
        created_at: now,
      },
      {
        id: secretDbB,
        app_id: null,
        project_id: orgB,
        scope: "shared",
        phase: "runtime",
        key: "legacy-db-b",
        value_ciphertext: Buffer.from(sharedCiphertext),
        nonce: Buffer.from(sharedNonce),
        linked_database_id: databaseB,
        created_at: now,
      },
    ])
    await db.insert(backup_configs).values([
      {
        id: `backfill-config-a-${suffix}`,
        database_id: databaseA,
        destination_id: null,
        destination_kind: "s3",
        s3_endpoint: "https://s3.backfill.test",
        s3_bucket: "shared-bucket",
        s3_prefix: "database/prefix-a",
        s3_region: "eu-west-1",
        s3_credentials_secret_id: secretDbA,
        created_at: now,
      },
      {
        id: `backfill-config-b-${suffix}`,
        database_id: databaseB,
        destination_id: null,
        destination_kind: "s3",
        s3_endpoint: "https://s3.backfill.test",
        s3_bucket: "shared-bucket",
        s3_prefix: "database/prefix-b",
        s3_region: "eu-west-1",
        s3_credentials_secret_id: secretDbB,
        created_at: now,
      },
    ])
    await db.insert(volume_backup_configs).values({
      id: `backfill-volume-config-a-${suffix}`,
      app_id: appA,
      volume_id: volumeA,
      destination_id: null,
      destination_kind: "s3",
      s3_endpoint: "https://s3.backfill.test",
      s3_bucket: "shared-bucket",
      s3_prefix: "volume/prefix-a",
      s3_region: "eu-west-1",
      s3_credentials_secret_id: secretVolumeA,
      created_at: now,
    })

    const userSecretA = `backfill-user-secret-a-${suffix}`
    const userSecretB = `backfill-user-secret-b-${suffix}`
    await db.insert(secrets).values([
      {
        id: userSecretA,
        app_id: null,
        project_id: orgA,
        scope: "shared",
        phase: "runtime",
        key: "user-created-a",
        value_ciphertext: Buffer.from(sharedCiphertext),
        nonce: Buffer.from(sharedNonce),
        linked_database_id: null,
        created_at: now,
      },
      {
        id: userSecretB,
        app_id: null,
        project_id: orgA,
        scope: "shared",
        phase: "runtime",
        key: "user-created-b",
        value_ciphertext: Buffer.from(sharedCiphertext),
        nonce: Buffer.from(sharedNonce),
        linked_database_id: null,
        created_at: now,
      },
    ])
    await db.insert(storage_destinations).values([
      {
        id: `user-created-destination-a-${suffix}`,
        org_id: orgA,
        name: "User duplicate A",
        kind: "s3",
        s3_endpoint: "https://s3.backfill.test",
        s3_bucket: "shared-bucket",
        s3_region: "eu-west-1",
        credentials_secret_id: userSecretA,
        created_at: now,
        updated_at: now,
      },
      {
        id: `user-created-destination-b-${suffix}`,
        org_id: orgA,
        name: "User duplicate B",
        kind: "s3",
        s3_endpoint: "https://s3.backfill.test",
        s3_bucket: "shared-bucket",
        s3_region: "eu-west-1",
        credentials_secret_id: userSecretB,
        created_at: new Date(now.getTime() + 1),
        updated_at: new Date(now.getTime() + 1),
      },
    ])

    for (const migrationName of [
      "0091_storage_destinations.sql",
      "0092_storage_destination_secret_ownership.sql",
      "0093_storage_destination_secret_cloning.sql",
    ]) {
      const migration = await Bun.file(
        new URL(`../migrations/${migrationName}`, import.meta.url)
      ).text()
      for (const statement of migration
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean)) {
        await db.execute(sql.raw(statement))
      }
    }

    const sqlStageDestinations = await db
      .select()
      .from(storage_destinations)
      .where(sql`org_id = ${orgA} AND id LIKE 'legacy-%'`)
    expect(sqlStageDestinations.length).toBeGreaterThanOrEqual(2)
    const sqlStageDestinationIds = sqlStageDestinations.map(
      (candidate) => candidate.id
    )
    for (const candidate of sqlStageDestinations) {
      if (!candidate.credentials_secret_id) continue
      const [ownedSecret] = await db
        .select()
        .from(secrets)
        .where(eq(secrets.id, candidate.credentials_secret_id))
      expect(ownedSecret).toMatchObject({
        project_id: orgA,
        app_id: null,
        linked_database_id: null,
      })
    }

    await backfillStorageDestinations(db, fixtureMasterKey)

    const databaseConfig = await db
      .select()
      .from(backup_configs)
      .where(eq(backup_configs.id, `backfill-config-a-${suffix}`))
    const volumeConfig = await db
      .select()
      .from(volume_backup_configs)
      .where(eq(volume_backup_configs.id, `backfill-volume-config-a-${suffix}`))
    const otherWorkspaceConfig = await db
      .select()
      .from(backup_configs)
      .where(eq(backup_configs.id, `backfill-config-b-${suffix}`))
    expect(databaseConfig[0]?.destination_id).toBe(
      volumeConfig[0]?.destination_id
    )
    expect(databaseConfig[0]?.destination_id).not.toBeNull()
    expect(otherWorkspaceConfig[0]?.destination_id).not.toBe(
      databaseConfig[0]?.destination_id
    )
    expect(databaseConfig[0]?.s3_prefix).toBe("database/prefix-a")
    expect(volumeConfig[0]?.s3_prefix).toBe("volume/prefix-a")
    expect(otherWorkspaceConfig[0]?.s3_prefix).toBe("database/prefix-b")

    const destinations = await db
      .select()
      .from(storage_destinations)
      .where(eq(storage_destinations.org_id, orgA))
    expect(destinations).toHaveLength(3)
    expect(destinations.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        `user-created-destination-a-${suffix}`,
        `user-created-destination-b-${suffix}`,
        databaseConfig[0]!.destination_id!,
      ])
    )
    const migratedDestination = destinations.find(
      (row) => row.id === databaseConfig[0]?.destination_id
    )
    const migratedSecret = await db
      .select()
      .from(secrets)
      .where(eq(secrets.id, migratedDestination!.credentials_secret_id!))
    expect(migratedSecret[0]).toMatchObject({
      project_id: orgA,
      app_id: null,
      linked_database_id: null,
      scope: "shared",
      phase: "runtime",
    })
    expect(migratedDestination?.name).toBe(
      "Migrated S3: shared-bucket (https://s3.backfill.test)"
    )

    const remainingLegacyDestinations = await db
      .select({ id: storage_destinations.id })
      .from(storage_destinations)
      .where(sql`org_id = ${orgA} AND id LIKE 'legacy-%'`)
    const removedLegacyDestinationIds = sqlStageDestinationIds.filter(
      (id) => !remainingLegacyDestinations.some((row) => row.id === id)
    )
    for (const destinationId of removedLegacyDestinationIds) {
      expect(
        await db
          .select({ id: secrets.id })
          .from(secrets)
          .where(eq(secrets.id, `storage-destination-secret-${destinationId}`))
      ).toHaveLength(0)
    }

    const userDestination = await db
      .select()
      .from(storage_destinations)
      .where(eq(storage_destinations.id, `user-created-destination-a-${suffix}`))
    expect(userDestination[0]?.credentials_secret_id).toBe(
      `storage-destination-secret-user-created-destination-a-${suffix}`
    )
    await db.delete(secrets).where(eq(secrets.id, userSecretA))
    expect(
      await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          eq(
            secrets.id,
            `storage-destination-secret-user-created-destination-a-${suffix}`
          )
        )
    ).toHaveLength(1)

    const editedLegacyDestinationId = `legacy-edited-${suffix}`
    await db.insert(storage_destinations).values({
      id: editedLegacyDestinationId,
      org_id: orgA,
      name: "Custom migrated destination",
      kind: "s3",
      s3_endpoint: "https://s3.backfill.test",
      s3_bucket: "shared-bucket",
      s3_region: "eu-west-1",
      credentials_secret_id: migratedDestination!.credentials_secret_id,
      created_at: now,
      updated_at: now,
    })
    await backfillStorageDestinations(db, fixtureMasterKey)
    expect(
      (await db
        .select()
        .from(storage_destinations)
        .where(eq(storage_destinations.org_id, orgA)))
    ).toHaveLength(4)
    expect(
      await db
        .select({ id: storage_destinations.id })
        .from(storage_destinations)
        .where(eq(storage_destinations.id, editedLegacyDestinationId))
    ).toHaveLength(1)
  })
})
