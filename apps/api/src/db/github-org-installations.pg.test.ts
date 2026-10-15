// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import postgres from "postgres"
import { eq, inArray } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  apps,
  github_installation_legacy_backfill,
  github_installation_users,
  memberships,
  projects,
  provider_installations,
  users,
} from "@ploydok/db"
import type { Db } from "@ploydok/db"
import {
  backfillLegacyGitHubInstallationGrants,
  grantGitHubInstallationToOrganization,
  listGitHubInstallationIdsForOrganizationAndUser,
  organizationHasGitHubInstallationGrant,
  revokeGitHubInstallationFromOrganization,
  userOwnsPersonalGitHubInstallation,
} from "@ploydok/db/queries"
import { makeTestDb, TEST_PG_URL } from "../test/db-helpers"

const skip = !TEST_PG_URL
if (skip) {
  console.log(
    "[github-org-installations.pg] PLOYDOK_TEST_PG_URL not set: skipping"
  )
}

const migrationPath = join(
  import.meta.dir,
  "../../../..",
  "packages/db/migrations/0089_org_github_installations.sql"
)
const legacyBackfillMigrationPath = join(
  import.meta.dir,
  "../../../..",
  "packages/db/migrations/0090_github_installation_legacy_backfill.sql"
)

async function runOrgGrantMigrationInTempSchema(): Promise<{
  first: Array<{ org_id: string; installation_id: string }>
  second: Array<{ org_id: string; installation_id: string }>
  legacyMarkers: Array<{ installation_id: string; user_id: string }>
  legacyMarkersAfterRerun: Array<{ installation_id: string; user_id: string }>
}> {
  const sql = postgres(TEST_PG_URL!, { max: 1 })
  const [migration, legacyBackfillMigration] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(legacyBackfillMigrationPath, "utf8"),
  ])
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
  const legacyBackfillStatements = legacyBackfillMigration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)

  try {
    return await sql.begin(async (tx) => {
      // The temporary tables shadow the production tables for this migration
      // proof, keeping the fixture independent from the rest of the database.
      await tx.unsafe("SET LOCAL search_path TO pg_temp")
      await tx.unsafe(
        `CREATE TEMP TABLE "users" ("id" text PRIMARY KEY) ON COMMIT PRESERVE ROWS`
      )
      await tx.unsafe(
        `CREATE TEMP TABLE "projects" (
          "id" text PRIMARY KEY,
          "owner_id" text NOT NULL
        ) ON COMMIT PRESERVE ROWS`
      )
      await tx.unsafe(
        `CREATE TEMP TABLE "memberships" (
          "org_id" text NOT NULL,
          "user_id" text NOT NULL,
          "role" text NOT NULL,
          "accepted_at" timestamptz
        ) ON COMMIT PRESERVE ROWS`
      )
      await tx.unsafe(
        `CREATE TEMP TABLE "provider_installations" (
          "id" text PRIMARY KEY,
          "provider" text NOT NULL,
          "external_id" text NOT NULL
        ) ON COMMIT PRESERVE ROWS`
      )
      await tx.unsafe(
        `CREATE TEMP TABLE "github_installation_users" (
          "installation_id" text NOT NULL,
          "user_id" text NOT NULL
        ) ON COMMIT PRESERVE ROWS`
      )

      const suffix = `migration-${nanoid(8)}`
      const installer = `${suffix}-installer`
      const member = `${suffix}-member`
      const pending = `${suffix}-pending`
      const legacyOwner = `${suffix}-legacy-owner`
      const acceptedOrgA = `${suffix}-org-a`
      const acceptedOrgB = `${suffix}-org-b`
      const memberOrg = `${suffix}-member-org`
      const pendingOrg = `${suffix}-pending-org`
      const legacyOrg = `${suffix}-legacy-org`
      const acceptedInstallation = `${suffix}-accepted`
      const prefixedInstallation = `${suffix}-prefixed`
      const memberInstallation = `${suffix}-member-installation`
      const pendingInstallation = `${suffix}-pending-installation`
      const legacyInstallation = `${suffix}-legacy-installation`
      const orphanUser = `${suffix}-orphan-user`
      const orphanOrg = `${suffix}-orphan-org`
      const orphanInstallation = `${suffix}-orphan-installation`

      await tx`
        INSERT INTO "users" ("id") VALUES
          (${installer}), (${member}), (${pending}), (${legacyOwner}), (${orphanUser})
      `
      await tx`
        INSERT INTO "projects" ("id", "owner_id") VALUES
          (${acceptedOrgA}, ${installer}),
          (${acceptedOrgB}, ${installer}),
          (${memberOrg}, ${installer}),
          (${pendingOrg}, ${installer}),
          (${legacyOrg}, ${legacyOwner}),
          (${orphanOrg}, ${orphanUser})
      `
      await tx`
        INSERT INTO "memberships" ("org_id", "user_id", "role", "accepted_at") VALUES
          (${acceptedOrgA}, ${installer}, 'owner', now()),
          (${acceptedOrgB}, ${installer}, 'owner', now()),
          (${memberOrg}, ${member}, 'member', now()),
          (${pendingOrg}, ${pending}, 'owner', NULL),
          (${orphanOrg}, ${orphanUser}, 'owner', now())
      `
      await tx`
        INSERT INTO "provider_installations" ("id", "provider", "external_id") VALUES
          (${`github:${acceptedInstallation}`}, 'github', ${acceptedInstallation}),
          (${`github:${prefixedInstallation}`}, 'github', ${prefixedInstallation}),
          (${`github:${memberInstallation}`}, 'github', ${memberInstallation}),
          (${`github:${pendingInstallation}`}, 'github', ${pendingInstallation}),
          (${`github:${legacyInstallation}`}, 'github', ${legacyInstallation})
      `
      await tx`
        INSERT INTO "github_installation_users" ("installation_id", "user_id") VALUES
          (${acceptedInstallation}, ${installer}),
          (${`github:${prefixedInstallation}`}, ${installer}),
          (${memberInstallation}, ${member}),
          (${pendingInstallation}, ${pending}),
          (${legacyInstallation}, ${legacyOwner}),
          (${orphanInstallation}, ${orphanUser})
      `

      for (const statement of statements) await tx.unsafe(statement)
      for (const statement of legacyBackfillStatements)
        await tx.unsafe(statement)
      const [tableSchema] = await tx.unsafe<{ schema: string }[]>(
        `SELECT n.nspname AS schema
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = 'org_github_installations'::regclass
            AND c.relnamespace = pg_my_temp_schema()`
      )
      expect(tableSchema?.schema).toMatch(/^pg_temp_/)

      const first = await tx.unsafe<{
        org_id: string
        installation_id: string
      }[]>(
        `SELECT "org_id", "installation_id"
           FROM "org_github_installations"
          ORDER BY "org_id", "installation_id"`
      )

      const legacyMarkers = await tx.unsafe<{
        installation_id: string
        user_id: string
      }[]>(
        `SELECT "installation_id", "user_id"
           FROM "github_installation_legacy_backfill"
          ORDER BY "installation_id", "user_id"`
      )

      // A link created after the first application must not be captured when
      // the repair migration is replayed.
      const postMigrationInstallation = `${suffix}-post-migration-installation`
      await tx`
        INSERT INTO "github_installation_users" ("installation_id", "user_id")
        VALUES (${postMigrationInstallation}, ${orphanUser})
      `

      for (const statement of statements) await tx.unsafe(statement)
      for (const statement of legacyBackfillStatements)
        await tx.unsafe(statement)
      const second = await tx.unsafe<{
        org_id: string
        installation_id: string
      }[]>(
        `SELECT "org_id", "installation_id"
           FROM "org_github_installations"
          ORDER BY "org_id", "installation_id"`
      )

      const legacyMarkersAfterRerun = await tx.unsafe<{
        installation_id: string
        user_id: string
      }[]>(
        `SELECT "installation_id", "user_id"
           FROM "github_installation_legacy_backfill"
          ORDER BY "installation_id", "user_id"`
      )

      return { first, second, legacyMarkers, legacyMarkersAfterRerun }
    })
  } finally {
    await sql.end()
  }
}

describe.skipIf(skip)("GitHub organization installation grants", () => {
  let db: Db
  let cleanup: () => Promise<void>
  const suffix = `org-grant-${nanoid(8)}`
  const ownerId = `${suffix}-owner`
  const memberId = `${suffix}-member`
  const orgId = `${suffix}-org`
  const otherOrgId = `${suffix}-other-org`
  const installationId = `${suffix}-installation`
  const personalInstallationId = `${suffix}-personal`
  const appId = `${suffix}-app`

  beforeAll(async () => {
    ;({ db, cleanup } = await makeTestDb())
    const now = new Date()
    await db.insert(users).values([
      {
        id: ownerId,
        email: `${ownerId}@example.test`,
        display_name: "Grant Owner",
        created_at: now,
        updated_at: now,
      },
      {
        id: memberId,
        email: `${memberId}@example.test`,
        display_name: "Grant Member",
        created_at: now,
        updated_at: now,
      },
    ])
    await db.insert(projects).values([
      {
        id: orgId,
        owner_id: ownerId,
        name: "Grant Org",
        slug: orgId,
        created_at: now,
      },
      {
        id: otherOrgId,
        owner_id: ownerId,
        name: "Other Org",
        slug: otherOrgId,
        created_at: now,
      },
    ])
    await db.insert(memberships).values([
      {
        id: `${suffix}-owner-membership`,
        org_id: orgId,
        user_id: ownerId,
        role: "owner",
        accepted_at: now,
      },
      {
        id: `${suffix}-member-membership`,
        org_id: orgId,
        user_id: memberId,
        role: "member",
        accepted_at: now,
      },
    ])
    await db.insert(provider_installations).values([
      {
        id: `github:${installationId}`,
        provider: "github",
        external_id: installationId,
        account_login: "acme",
        account_type: "Organization",
        repository_selection: "all",
        suspended_at: null,
        html_url: null,
        avatar_url: null,
        repository_count: 1,
        last_synced_at: now,
        created_at: now,
      },
      {
        id: `github:${personalInstallationId}`,
        provider: "github",
        external_id: personalInstallationId,
        account_login: "grant-owner",
        account_type: "User",
        repository_selection: "selected",
        suspended_at: null,
        html_url: null,
        avatar_url: null,
        repository_count: 1,
        last_synced_at: now,
        created_at: now,
      },
    ])
    await db.insert(github_installation_users).values([
      { installation_id: installationId, user_id: ownerId },
      { installation_id: personalInstallationId, user_id: ownerId },
    ])
  })

  afterAll(async () => {
    await db.delete(apps).where(eq(apps.id, appId)).catch(() => undefined)
    await db
      .delete(provider_installations)
      .where(
        inArray(provider_installations.id, [
          `github:${installationId}`,
          `github:${personalInstallationId}`,
        ])
      )
      .catch(() => undefined)
    await db.delete(users).where(inArray(users.id, [ownerId, memberId]))
    await cleanup()
    await db.$client.end()
  })

  it("backfills only accepted owner memberships and is idempotent", async () => {
    const result = await runOrgGrantMigrationInTempSchema()
    expect(result.first).toEqual(result.second)
    expect(result.first).toEqual(
      expect.arrayContaining([
        {
          org_id: expect.stringContaining("migration-"),
          installation_id: expect.stringContaining("github:migration-"),
        },
      ])
    )
    expect(result.first).toHaveLength(4)
    expect(result.first.every((row) => !row.org_id.endsWith("member-org"))).toBe(
      true
    )
    expect(result.first.every((row) => !row.org_id.endsWith("pending-org"))).toBe(
      true
    )
    expect(result.first.every((row) => !row.org_id.endsWith("legacy-org"))).toBe(
      true
    )
    expect(
      result.first.some((row) => row.installation_id.includes("prefixed"))
    ).toBe(true)
    expect(result.legacyMarkers).toEqual([
      {
        installation_id: expect.stringContaining("orphan-installation"),
        user_id: expect.stringContaining("orphan-user"),
      },
    ])
    expect(result.legacyMarkersAfterRerun).toEqual(result.legacyMarkers)
  })

  it("backfills a delayed orphan once and never re-shares it on later syncs", async () => {
    const delayedSuffix = `${suffix}-delayed`
    const delayedUser = `${delayedSuffix}-user`
    const delayedOrg = `${delayedSuffix}-org`
    const delayedInstallation = `${delayedSuffix}-installation`
    const removedInstallation = `${delayedSuffix}-removed-installation`
    const newUser = `${delayedSuffix}-new-user`
    const newOrg = `${delayedSuffix}-new-org`
    const newInstallation = `${delayedSuffix}-new-installation`
    const now = new Date()

    await db.insert(users).values([
      {
        id: delayedUser,
        email: `${delayedUser}@example.test`,
        display_name: "Delayed legacy user",
        created_at: now,
        updated_at: now,
      },
      {
        id: newUser,
        email: `${newUser}@example.test`,
        display_name: "New personal user",
        created_at: now,
        updated_at: now,
      },
    ])
    await db.insert(projects).values([
      {
        id: delayedOrg,
        owner_id: delayedUser,
        name: "Delayed legacy org",
        slug: delayedOrg,
        created_at: now,
      },
      {
        id: newOrg,
        owner_id: newUser,
        name: "New personal org",
        slug: newOrg,
        created_at: now,
      },
    ])
    await db.insert(memberships).values([
      {
        id: `${delayedSuffix}-membership`,
        org_id: delayedOrg,
        user_id: delayedUser,
        role: "owner",
        accepted_at: now,
      },
      {
        id: `${delayedSuffix}-new-membership`,
        org_id: newOrg,
        user_id: newUser,
        role: "owner",
        accepted_at: now,
      },
    ])

    try {
      // This marker represents the orphan link captured by migration 0090.
      await db.insert(github_installation_legacy_backfill).values([
        {
          installation_id: delayedInstallation,
          user_id: delayedUser,
          created_at: now,
        },
        {
          installation_id: removedInstallation,
          user_id: delayedUser,
          created_at: now,
        },
      ])
      await db.insert(github_installation_users).values({
        installation_id: delayedInstallation,
        user_id: delayedUser,
        created_at: now,
        updated_at: now,
      })
      await db.insert(provider_installations).values({
        id: `github:${delayedInstallation}`,
        provider: "github",
        external_id: delayedInstallation,
        account_login: "legacy-owner",
        account_type: "Organization",
        repository_selection: "all",
        suspended_at: null,
        html_url: null,
        avatar_url: null,
        repository_count: 0,
        last_synced_at: now,
        created_at: now,
      })
      await db.insert(provider_installations).values({
        id: `github:${removedInstallation}`,
        provider: "github",
        external_id: removedInstallation,
        account_login: "removed-owner",
        account_type: "Organization",
        repository_selection: "all",
        suspended_at: null,
        html_url: null,
        avatar_url: null,
        repository_count: 0,
        last_synced_at: now,
        created_at: now,
      })

      await expect(
        backfillLegacyGitHubInstallationGrants(db, delayedInstallation)
      ).resolves.toBe(1)
      await expect(
        organizationHasGitHubInstallationGrant(
          db,
          delayedOrg,
          delayedInstallation
        )
      ).resolves.toBe(true)

      // A later sync must not recreate an explicitly revoked grant because the
      // consumed marker is retained.
      await expect(
        revokeGitHubInstallationFromOrganization(
          db,
          delayedOrg,
          delayedInstallation
        )
      ).resolves.toBe(true)
      await expect(
        backfillLegacyGitHubInstallationGrants(db, delayedInstallation)
      ).resolves.toBe(0)
      await expect(
        organizationHasGitHubInstallationGrant(
          db,
          delayedOrg,
          delayedInstallation
        )
      ).resolves.toBe(false)

      // A marker whose callback link was removed before the first sync is
      // consumed without granting access, and a later re-add cannot revive it.
      await expect(
        backfillLegacyGitHubInstallationGrants(db, removedInstallation)
      ).resolves.toBe(0)
      const [removedMarker] = await db
        .select({ consumed_at: github_installation_legacy_backfill.consumed_at })
        .from(github_installation_legacy_backfill)
        .where(
          eq(
            github_installation_legacy_backfill.installation_id,
            removedInstallation
          )
        )
      expect(removedMarker?.consumed_at).toBeInstanceOf(Date)
      await db.insert(github_installation_users).values({
        installation_id: removedInstallation,
        user_id: delayedUser,
        created_at: now,
        updated_at: now,
      })
      await expect(
        backfillLegacyGitHubInstallationGrants(db, removedInstallation)
      ).resolves.toBe(0)

      // A new post-migration personal link has no legacy marker and remains
      // private until an owner explicitly grants it.
      await db.insert(github_installation_users).values({
        installation_id: newInstallation,
        user_id: newUser,
        created_at: now,
        updated_at: now,
      })
      await db.insert(provider_installations).values({
        id: `github:${newInstallation}`,
        provider: "github",
        external_id: newInstallation,
        account_login: "new-personal",
        account_type: "User",
        repository_selection: "selected",
        suspended_at: null,
        html_url: null,
        avatar_url: null,
        repository_count: 0,
        last_synced_at: now,
        created_at: now,
      })
      await expect(
        backfillLegacyGitHubInstallationGrants(db, newInstallation)
      ).resolves.toBe(0)
      await expect(
        organizationHasGitHubInstallationGrant(db, newOrg, newInstallation)
      ).resolves.toBe(false)
    } finally {
      await db
        .delete(provider_installations)
        .where(
          inArray(provider_installations.id, [
            `github:${delayedInstallation}`,
            `github:${removedInstallation}`,
            `github:${newInstallation}`,
          ])
        )
      await db.delete(users).where(inArray(users.id, [delayedUser, newUser]))
    }
  })

  it("isolates grants by organization while retaining the caller's personal install", async () => {
    await grantGitHubInstallationToOrganization(
      db,
      orgId,
      installationId,
      ownerId
    )

    await expect(
      listGitHubInstallationIdsForOrganizationAndUser(db, orgId, ownerId)
    ).resolves.toEqual(expect.arrayContaining([installationId, personalInstallationId]))
    await expect(
      listGitHubInstallationIdsForOrganizationAndUser(db, orgId, memberId)
    ).resolves.toEqual([installationId])
    await expect(
      listGitHubInstallationIdsForOrganizationAndUser(db, otherOrgId, memberId)
    ).resolves.toEqual([])
    await expect(
      organizationHasGitHubInstallationGrant(db, orgId, installationId)
    ).resolves.toBe(true)
    await expect(
      organizationHasGitHubInstallationGrant(db, otherOrgId, installationId)
    ).resolves.toBe(false)
    await expect(
      userOwnsPersonalGitHubInstallation(db, ownerId, personalInstallationId)
    ).resolves.toBe(true)
    await expect(
      userOwnsPersonalGitHubInstallation(db, memberId, personalInstallationId)
    ).resolves.toBe(false)
    await expect(
      userOwnsPersonalGitHubInstallation(db, ownerId, installationId)
    ).resolves.toBe(false)
  })

  it("revokes only the organization grant and leaves the installation/app reference", async () => {
    await grantGitHubInstallationToOrganization(
      db,
      orgId,
      installationId,
      ownerId
    )
    await db.insert(apps).values({
      id: appId,
      project_id: orgId,
      name: "Grant App",
      slug: appId,
      git_provider: "github",
      repo_full_name: "acme/api",
      branch: "main",
      github_installation_id: installationId,
      created_at: new Date(),
      updated_at: new Date(),
    })

    await expect(
      revokeGitHubInstallationFromOrganization(db, orgId, installationId)
    ).resolves.toBe(true)
    await expect(
      organizationHasGitHubInstallationGrant(db, orgId, installationId)
    ).resolves.toBe(false)
    await expect(
      listGitHubInstallationIdsForOrganizationAndUser(db, orgId, memberId)
    ).resolves.toEqual([])

    const [installation] = await db
      .select({ id: provider_installations.id })
      .from(provider_installations)
      .where(eq(provider_installations.id, `github:${installationId}`))
    const [app] = await db
      .select({ github_installation_id: apps.github_installation_id })
      .from(apps)
      .where(eq(apps.id, appId))
    expect(installation?.id).toBe(`github:${installationId}`)
    expect(app?.github_installation_id).toBe(installationId)
    await expect(
      revokeGitHubInstallationFromOrganization(db, orgId, installationId)
    ).resolves.toBe(false)
  })
})
