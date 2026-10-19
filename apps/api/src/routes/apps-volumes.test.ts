// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { nanoid } from "nanoid"
import { eq } from "drizzle-orm"
import { apps, memberships, passkeys, projects, users } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { createAppsVolumesRouter } from "./apps-volumes"
import { makeTestDb as makePgTestDb, TEST_PG_URL } from "../test/db-helpers"
import type { AuthUser } from "../auth/middleware"

const skip = !TEST_PG_URL
if (skip) {
  console.log("[apps-volumes.test] PLOYDOK_TEST_PG_URL not set — skipping")
}

async function makeTestDb() {
  const { db } = await makePgTestDb()
  return db
}

type TestDb = Db

async function createTestUser(db: TestDb) {
  const id = nanoid()
  const now = new Date()
  await db.insert(users).values({
    id,
    email: `user-${id}@test.com`,
    display_name: "Test User",
    created_at: now,
    updated_at: now,
    recovery_token_hash: null,
    recovery_expires_at: null,
  })
  for (let index = 0; index < 2; index++) {
    await db.insert(passkeys).values({
      id: nanoid(),
      user_id: id,
      credential_id: `cred-${id}-${index}`,
      public_key: Buffer.from("test-public-key"),
      counter: 0,
      transports: "[]",
      device_name: "Test passkey",
      created_at: now,
      last_used_at: now,
    })
  }
  return { id, email: `user-${id}@test.com` }
}

async function createTestProject(db: TestDb, ownerId: string) {
  const id = nanoid()
  const now = new Date()
  await db.insert(projects).values({
    id,
    owner_id: ownerId,
    name: `Project ${id}`,
    slug: `proj-${id}`,
    created_at: now,
  })
  await db.insert(memberships).values({
    id: nanoid(),
    org_id: id,
    user_id: ownerId,
    role: "owner",
    invited_by: null,
    invited_at: now,
    accepted_at: now,
  })
  return { id }
}

async function createTestApp(db: TestDb, opts: { projectId: string; name?: string }) {
  const id = nanoid()
  const now = new Date()
  const name = opts.name ?? `App ${id}`
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32)

  await db.insert(apps).values({
    id,
    project_id: opts.projectId,
    name,
    slug,
    status: "created",
    created_at: now,
    updated_at: now,
    git_provider: "github",
    repo_full_name: "owner/repo",
    branch: "main",
    restart_policy: "unless-stopped",
    domain: `${slug}.demo.ploydok.local`,
    build_method: "auto",
    healthcheck_path: "/",
    healthcheck_port: null,
    healthcheck_interval_s: 5,
    healthcheck_timeout_s: 3,
    healthcheck_retries: 6,
    healthcheck_start_period_s: 0,
  })

  return { id }
}

function fakeUser(id: string, email: string): AuthUser {
  return { id, email, display_name: "Test User", session_id: "sess-test" }
}

function buildTestApp(db: TestDb, authedUser: AuthUser): Hono {
  const honoApp = new Hono()
  honoApp.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("user", authedUser)
    return next()
  })
  honoApp.route("/apps", createAppsVolumesRouter(db))
  return honoApp
}

describe.skipIf(skip)("apps volumes routes", () => {
  let db: TestDb
  let userId: string
  let userEmail: string
  let projectId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id
    userEmail = user.email
    const project = await createTestProject(db, userId)
    projectId = project.id
    ;({ id: appId } = await createTestApp(db, { projectId }))
  })

  it("creates, lists, updates and deletes an app volume with the expected host path convention", async () => {
    const app = buildTestApp(db, fakeUser(userId, userEmail))

    const createRes = await app.request(`/apps/${appId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "data",
        mountPath: "/data",
        sizeLimitBytes: 1024,
      }),
    })

    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as {
      volume: { id: string; hostPath: string; mountPath: string; name: string }
    }
    expect(created.volume.name).toBe("data")
    expect(created.volume.mountPath).toBe("/data")
    expect(created.volume.hostPath).toBe(
      `/var/lib/ploydok/app-volumes/${appId}/${created.volume.id}`
    )

    const listRes = await app.request(`/apps/${appId}/volumes`)
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as {
      volumes: Array<{ id: string; hostPath: string }>
    }
    expect(listed.volumes).toHaveLength(1)
    expect(listed.volumes[0]?.hostPath).toBe(created.volume.hostPath)

    const patchRes = await app.request(
      `/apps/${appId}/volumes/${created.volume.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mountPath: "/var/lib/data",
          sizeLimitBytes: 2048,
        }),
      }
    )

    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as {
      volume: { mountPath: string; sizeLimitBytes: number | null }
    }
    expect(patched.volume.mountPath).toBe("/var/lib/data")
    expect(patched.volume.sizeLimitBytes).toBe(2048)

    const deleteRes = await app.request(
      `/apps/${appId}/volumes/${created.volume.id}`,
      { method: "DELETE" }
    )
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ ok: true })
  })

  it("rejects deletion when the app is still live", async () => {
    const app = buildTestApp(db, fakeUser(userId, userEmail))

    const createRes = await app.request(`/apps/${appId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "cache",
        mountPath: "/cache",
      }),
    })
    const created = (await createRes.json()) as { volume: { id: string } }

    await db
      .update(apps)
      .set({
        status: "running",
        container_id: "ploydok-app-demo-blue",
        updated_at: new Date(),
      })
      .where(eq(apps.id, appId))

    const deleteRes = await app.request(
      `/apps/${appId}/volumes/${created.volume.id}`,
      { method: "DELETE" }
    )

    expect(deleteRes.status).toBe(409)
    const body = (await deleteRes.json()) as {
      error: { code: string; message: string }
    }
    expect(body.error.code).toBe("INVALID_STATE")
    expect(body.error.message).toContain("Stop the app")
  })
})
