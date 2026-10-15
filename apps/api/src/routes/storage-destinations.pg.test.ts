// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import {
  apps,
  app_volumes,
  backup_configs,
  databases,
  memberships,
  projects,
  secrets,
  storage_destinations,
  users,
  volume_backup_configs,
  type Db,
} from "@ploydok/db"
import type { AuthUser } from "../auth/middleware"
import { createStorageDestinationsRouter } from "./storage-destinations"
import { makeTestDb, TEST_PG_URL } from "../test/db-helpers"

const skip = !TEST_PG_URL

type TestUser = AuthUser & { token_scopes?: string[] }

function request(
  method: string,
  path: string,
  body?: unknown
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function testApp(db: Db, user: TestUser): Hono {
  const app = new Hono()
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("user", user)
    await next()
  })
  app.route("/orgs", createStorageDestinationsRouter(db))
  return app
}

async function seedOrg(db: Db, suffix: string) {
  const now = new Date()
  const ownerId = `storage-owner-${suffix}`
  const memberId = `storage-member-${suffix}`
  const orgId = `storage-org-${suffix}`
  await db.insert(users).values([
    {
      id: ownerId,
      email: `${ownerId}@test.invalid`,
      display_name: "Storage Owner",
      created_at: now,
      updated_at: now,
    },
    {
      id: memberId,
      email: `${memberId}@test.invalid`,
      display_name: "Storage Member",
      created_at: now,
      updated_at: now,
    },
  ])
  await db.insert(projects).values({
    id: orgId,
    owner_id: ownerId,
    name: "Storage Test Workspace",
    slug: orgId,
    created_at: now,
  })
  await db.insert(memberships).values([
    {
      id: `storage-membership-owner-${suffix}`,
      org_id: orgId,
      user_id: ownerId,
      role: "owner",
      invited_by: null,
      accepted_at: now,
    },
    {
      id: `storage-membership-member-${suffix}`,
      org_id: orgId,
      user_id: memberId,
      role: "member",
      invited_by: ownerId,
      accepted_at: now,
    },
  ])
  return {
    orgId,
    owner: {
      id: ownerId,
      email: `${ownerId}@test.invalid`,
      display_name: "Storage Owner",
      session_id: `session-${suffix}`,
    } satisfies TestUser,
    member: {
      id: memberId,
      email: `${memberId}@test.invalid`,
      display_name: "Storage Member",
      session_id: `session-member-${suffix}`,
    } satisfies TestUser,
  }
}

describe.skipIf(skip)("workspace storage destination routes", () => {
  let db: Db
  const orgIds: string[] = []

  beforeEach(async () => {
    ;({ db } = await makeTestDb())
  })

  afterEach(async () => {
    for (const orgId of orgIds.splice(0)) {
      await db.delete(projects).where(eq(projects.id, orgId))
    }
  })

  it("scopes CRUD by membership and token scope, and never returns credentials", async () => {
    const fixture = await seedOrg(db, crypto.randomUUID().slice(0, 8))
    orgIds.push(fixture.orgId)
    const owner = { ...fixture.owner, token_scopes: ["storage:write"] }
    const ownerApp = testApp(db, owner)

    const create = await ownerApp.request(
      request("POST", `/orgs/${fixture.orgId}/storage-destinations`, {
        name: "Production R2",
        kind: "s3",
        endpoint: "https://s3.example.test",
        bucket: "backups",
        region: "auto",
        credentials: {
          accessKeyId: "access-key-that-must-stay-secret",
          secretAccessKey: "secret-key-that-must-stay-secret",
        },
      })
    )
    expect(create.status).toBe(201)
    const createText = await create.text()
    expect(createText).not.toContain("access-key-that-must-stay-secret")
    expect(createText).not.toContain("secret-key-that-must-stay-secret")
    const created = JSON.parse(createText) as {
      destination: { id: string; credentialsConfigured: boolean }
    }
    expect(created.destination.credentialsConfigured).toBe(true)

    const secretRows = await db
      .select()
      .from(secrets)
      .where(eq(secrets.project_id, fixture.orgId))
    expect(secretRows).toHaveLength(1)
    expect(secretRows[0]?.key).toContain("storage-destination:")
    expect(secretRows[0]?.value_ciphertext.toString("utf8")).not.toContain(
      "secret-key-that-must-stay-secret"
    )

    const rotation = await ownerApp.request(
      request(
        "PATCH",
        `/orgs/${fixture.orgId}/storage-destinations/${created.destination.id}`,
        {
          credentials: {
            accessKeyId: "rotated-access-key",
            secretAccessKey: "rotated-secret-key",
          },
        }
      )
    )
    expect(rotation.status).toBe(200)
    const rotationText = await rotation.text()
    expect(rotationText).not.toContain("rotated-access-key")
    expect(rotationText).not.toContain("rotated-secret-key")
    expect(
      await db
        .select()
        .from(secrets)
        .where(eq(secrets.project_id, fixture.orgId))
    ).toHaveLength(1)

    const clearBucket = await ownerApp.request(
      request(
        "PATCH",
        `/orgs/${fixture.orgId}/storage-destinations/${created.destination.id}`,
        { bucket: null }
      )
    )
    expect(clearBucket.status).toBe(400)
    expect(await clearBucket.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    })

    const memberRead = testApp(db, {
      ...fixture.member,
      token_scopes: ["storage:read"],
    })
    const list = await memberRead.request(
      request("GET", `/orgs/${fixture.orgId}/storage-destinations`)
    )
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      destinations: [
        {
          id: created.destination.id,
          name: "Production R2",
          credentialsConfigured: true,
          usageCount: 0,
        },
      ],
    })

    const memberWrite = testApp(db, {
      ...fixture.member,
      token_scopes: ["storage:write"],
    })
    const forbidden = await memberWrite.request(
      request(
        "PATCH",
        `/orgs/${fixture.orgId}/storage-destinations/${created.destination.id}`,
        { name: "Member must not rename" }
      )
    )
    expect(forbidden.status).toBe(403)

    const missingRead = testApp(db, {
      ...fixture.owner,
      token_scopes: ["apps:read"],
    })
    const scopeDenied = await missingRead.request(
      request("GET", `/orgs/${fixture.orgId}/storage-destinations`)
    )
    expect(scopeDenied.status).toBe(403)
  })

  it("counts database and volume references and refuses in-use deletion", async () => {
    const fixture = await seedOrg(db, crypto.randomUUID().slice(0, 8))
    orgIds.push(fixture.orgId)
    const ownerApp = testApp(db, fixture.owner)
    const create = await ownerApp.request(
      request("POST", `/orgs/${fixture.orgId}/storage-destinations`, {
        name: "Shared local destination",
        kind: "local",
      })
    )
    expect(create.status).toBe(201)
    const { destination } = (await create.json()) as {
      destination: { id: string }
    }

    const now = new Date()
    const databaseId = `storage-db-${crypto.randomUUID().slice(0, 8)}`
    const appId = `storage-app-${crypto.randomUUID().slice(0, 8)}`
    const volumeId = `storage-volume-${crypto.randomUUID().slice(0, 8)}`
    await db.insert(databases).values({
      id: databaseId,
      project_id: fixture.orgId,
      kind: "postgres",
      name: "Storage test database",
      plan: "small",
      volume_name: `${databaseId}-volume`,
      created_at: now,
    })
    await db.insert(apps).values({
      id: appId,
      project_id: fixture.orgId,
      name: "Storage test app",
      slug: appId,
      created_at: now,
      updated_at: now,
    })
    await db.insert(app_volumes).values({
      id: volumeId,
      app_id: appId,
      name: "data",
      mount_path: "/data",
      created_at: now,
    })
    await db.insert(backup_configs).values({
      id: `storage-backup-${databaseId}`,
      database_id: databaseId,
      destination_id: destination.id,
      destination_kind: "local",
      s3_prefix: "database/prefix",
      created_at: now,
    })
    await db.insert(volume_backup_configs).values({
      id: `storage-volume-backup-${volumeId}`,
      app_id: appId,
      volume_id: volumeId,
      destination_id: destination.id,
      destination_kind: "local",
      s3_prefix: "volume/prefix",
      created_at: now,
    })

    const list = await ownerApp.request(
      request("GET", `/orgs/${fixture.orgId}/storage-destinations`)
    )
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      destinations: [{ id: destination.id, usageCount: 2 }],
    })

    const deletion = await ownerApp.request(
      request(
        "DELETE",
        `/orgs/${fixture.orgId}/storage-destinations/${destination.id}`
      )
    )
    expect(deletion.status).toBe(409)
    expect(await deletion.json()).toMatchObject({
      error: { code: "DESTINATION_IN_USE" },
    })
    expect(
      await db
        .select({ id: storage_destinations.id })
        .from(storage_destinations)
        .where(eq(storage_destinations.id, destination.id))
    ).toHaveLength(1)
  })

  it("deletes the credentials secret together with an unused destination", async () => {
    const fixture = await seedOrg(db, crypto.randomUUID().slice(0, 8))
    orgIds.push(fixture.orgId)
    const ownerApp = testApp(db, {
      ...fixture.owner,
      token_scopes: ["storage:write"],
    })
    const create = await ownerApp.request(
      request("POST", `/orgs/${fixture.orgId}/storage-destinations`, {
        name: "Disposable R2",
        kind: "s3",
        endpoint: "https://s3.example.test",
        bucket: "backups",
        region: "auto",
        credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
      })
    )
    expect(create.status).toBe(201)
    const created = (await create.json()) as { destination: { id: string } }
    expect(
      await db.select().from(secrets).where(eq(secrets.project_id, fixture.orgId))
    ).toHaveLength(1)

    const deletion = await ownerApp.request(
      request(
        "DELETE",
        `/orgs/${fixture.orgId}/storage-destinations/${created.destination.id}`
      )
    )
    expect(deletion.status).toBe(200)
    expect(
      await db.select().from(secrets).where(eq(secrets.project_id, fixture.orgId))
    ).toHaveLength(0)
  })

  it("performs the local witness put/read/delete cycle and records failures", async () => {
    const fixture = await seedOrg(db, crypto.randomUUID().slice(0, 8))
    orgIds.push(fixture.orgId)
    const ownerApp = testApp(db, fixture.owner)
    const create = await ownerApp.request(
      request("POST", `/orgs/${fixture.orgId}/storage-destinations`, {
        name: "Local destination",
        kind: "local",
      })
    )
    const { destination } = (await create.json()) as {
      destination: { id: string }
    }
    const success = await ownerApp.request(
      request(
        "POST",
        `/orgs/${fixture.orgId}/storage-destinations/${destination.id}/test`
      )
    )
    expect(success.status).toBe(200)
    expect(await success.json()).toMatchObject({ ok: true })
    const successfulRow = await db
      .select()
      .from(storage_destinations)
      .where(eq(storage_destinations.id, destination.id))
    expect(successfulRow[0]?.last_test_status).toBe("success")

    const failedId = `storage-failure-${crypto.randomUUID().slice(0, 8)}`
    const now = new Date()
    await db.insert(storage_destinations).values({
      id: failedId,
      org_id: fixture.orgId,
      name: "Incomplete S3 destination",
      kind: "s3",
      s3_endpoint: "https://s3.example.test",
      s3_bucket: "backups",
      s3_region: "auto",
      credentials_secret_id: null,
      last_test_at: null,
      last_test_status: null,
      last_test_error: null,
      created_at: now,
      updated_at: now,
    })
    const failure = await ownerApp.request(
      request("POST", `/orgs/${fixture.orgId}/storage-destinations/${failedId}/test`)
    )
    expect(failure.status).toBe(502)
    expect(await failure.json()).toMatchObject({
      error: { code: "DESTINATION_TEST_FAILED" },
    })
    const failedRow = await db
      .select()
      .from(storage_destinations)
      .where(eq(storage_destinations.id, failedId))
    expect(failedRow[0]?.last_test_status).toBe("failure")
    expect(failedRow[0]?.last_test_error).toBe("unknown")
  })
})
