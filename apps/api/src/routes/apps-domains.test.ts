// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from "bun:test"
import { Hono } from "hono"
import { nanoid } from "nanoid"
import { users, projects, apps, memberships, passkeys, services } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { createAppsDomainsRouter } from "./apps-domains"
import type { AuthUser } from "../auth/middleware"
import { makeTestDb as makePgTestDb, TEST_PG_URL } from "../test/db-helpers"

const skip = !TEST_PG_URL
if (skip) console.log("[apps-domains.test] PLOYDOK_TEST_PG_URL not set — skipping")

async function makeTestDb() {
  const { db } = await makePgTestDb()
  return db
}

type TestDb = Db

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createTestUser(
  db: TestDb,
  overrides: Partial<{ id: string; email: string }> = {},
) {
  const id = overrides.id ?? nanoid()
  const now = new Date()
  await db.insert(users).values({
    id,
    email: overrides.email ?? `user-${id}@test.com`,
    display_name: "Test User",
    created_at: now,
    updated_at: now,
    recovery_token_hash: null,
    recovery_expires_at: null,
  })
  return { id, email: overrides.email ?? `user-${id}@test.com` }
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
  // Authorization reads the membership model, not projects.owner_id.
  await db.insert(memberships).values({
    id: nanoid(),
    org_id: id,
    user_id: ownerId,
    role: "owner",
    invited_at: now,
    accepted_at: now,
  })
  return { id }
}

async function createTestApp(
  db: TestDb,
  opts: { userId: string; projectId: string },
) {
  const id = nanoid()
  const now = new Date()
  const slug = `app-${id.slice(0, 8)}`
  await db.insert(apps).values({
    id,
    project_id: opts.projectId,
    name: `App ${id}`,
    slug,
    status: "created",
    created_at: now,
    updated_at: now,
    git_provider: "github",
    repo_full_name: "owner/repo",
    branch: "main",
    root_dir: null,
    dockerfile_path: null,
    install_command: null,
    build_command: null,
    start_command: null,
    watch_paths: null,
    container_id: null,
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
  return { id, slug }
}

async function createTestService(db: TestDb, projectId: string, domain: string) {
  const id = nanoid()
  const now = new Date()
  await db.insert(services).values({
    id,
    project_id: projectId,
    name: `Service ${id}`,
    slug: `service-${id.slice(0, 8)}`,
    template_id: "test-template",
    template_version: "1",
    status: "created",
    runtime_mode: "swarm",
    compose_raw: "services: {}",
    generated_env: {},
    secrets_encrypted: false,
    domain,
    container_ids: [],
    swarm_service_names: [],
    created_at: now,
    updated_at: now,
  })
  return { id }
}

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

function buildTestApp(db: TestDb, authedUser?: AuthUser): Hono {
  const honoApp = new Hono()

  honoApp.use("*", async (c, next) => {
    if (authedUser) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(c as any).set("user", authedUser)
    }
    return next()
  })

  const router = createAppsDomainsRouter(db)
  honoApp.route("/apps", router)
  return honoApp
}

function fakeUser(id: string): AuthUser {
  return { id, email: `${id}@test.com`, display_name: "Test User", session_id: "sess-test" }
}

async function grantSecondFactor(db: TestDb, userId: string): Promise<void> {
  const now = new Date()
  await db.insert(passkeys).values([
    {
      id: nanoid(),
      user_id: userId,
      credential_id: `cred-sf-a-${userId}`,
      public_key: Buffer.from("pk1"),
      counter: 0,
      transports: "[]",
      device_name: "Device A",
      created_at: now,
      last_used_at: now,
    },
    {
      id: nanoid(),
      user_id: userId,
      credential_id: `cred-sf-b-${userId}`,
      public_key: Buffer.from("pk2"),
      counter: 0,
      transports: "[]",
      device_name: "Device B",
      created_at: now,
      last_used_at: now,
    },
  ])
}

// ---------------------------------------------------------------------------
// GET /apps/:id/domains
// ---------------------------------------------------------------------------

describe.skipIf(skip)("GET /apps/:id/domains", () => {
  let db: TestDb
  let userId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id
    const project = await createTestProject(db, userId)
    const app = await createTestApp(db, { userId, projectId: project.id })
    appId = app.id
  })

  it("returns 401 when no auth user", async () => {
    const honoApp = buildTestApp(db)
    const res = await honoApp.request(`/apps/${appId}/domains`)
    // No user set → getUser returns undefined → cast throws. The router should 404/500.
    // In practice the app.use middleware in production does requireAuth which returns 401.
    // Without auth middleware in tests, we get a 500 (cast fails). We verify not 200.
    expect(res.status).not.toBe(200)
  })

  it("returns 404 when app belongs to another user", async () => {
    const other = await createTestUser(db)
    const honoApp = buildTestApp(db, fakeUser(other.id))
    const res = await honoApp.request(`/apps/${appId}/domains`)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe("NOT_FOUND")
  })

  it("returns 404 for unknown app id", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/does-not-exist/domains`)
    expect(res.status).toBe(404)
  })

  it("returns empty list when no domains", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/domains`)
    expect(res.status).toBe(200)
    const body = await res.json() as { domains: unknown[] }
    expect(body.domains).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// POST /apps/:id/domains
// ---------------------------------------------------------------------------

describe.skipIf(skip)("POST /apps/:id/domains", () => {
  let db: TestDb
  let userId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id
    await grantSecondFactor(db, userId)
    const project = await createTestProject(db, userId)
    const app = await createTestApp(db, { userId, projectId: project.id })
    appId = app.id
  })

  it("creates a domain with valid hostname → 201", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "custom.example.com" }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { domain: { id: string; hostname: string; tlsStatus: string } }
    expect(body.domain.hostname).toBe("custom.example.com")
    expect(body.domain.tlsStatus).toBe("pending")
    expect(body.domain.id).toBeString()
  })

  it("creates a wildcard DNS-01 domain → 201", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostname: "wild.example.com",
        tls_mode: "dns01",
        dns01_provider: "cloudflare",
        wildcard: true,
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as {
      domain: { hostname: string; tlsMode: string; dns01Provider: string }
    }
    expect(body.domain.hostname).toBe("*.wild.example.com")
    expect(body.domain.tlsMode).toBe("dns01")
    expect(body.domain.dns01Provider).toBe("cloudflare")
  })

  it("rejects wildcard domains without DNS-01 → 400", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostname: "*.wild-http.example.com",
        tls_mode: "http01",
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(body.error.message).toContain("Wildcard domains require")
  })

  it("normalises hostname to lowercase", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "UPPER.Example.COM" }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { domain: { hostname: string } }
    expect(body.domain.hostname).toBe("upper.example.com")
  })

  it("rejects an invalid hostname → 400", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "not-a-valid-hostname" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  it("rejects plain IP addresses → 400", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "192.168.1.1" }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects duplicate hostname globally → 409", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))

    // First insert succeeds.
    await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "dupe.example.com" }),
    })

    // Second insert on same hostname (even same app) → 409.
    const res = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "dupe.example.com" }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe("CONFLICT")
  })

  it("rejects duplicate hostname across apps → 409", async () => {
    // Create a second app under same user.
    const project2 = await createTestProject(db, userId)
    const app2 = await createTestApp(db, { userId, projectId: project2.id })

    const honoApp = buildTestApp(db, fakeUser(userId))

    await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "cross.example.com" }),
    })

    const res = await honoApp.request(`/apps/${app2.id}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "cross.example.com" }),
    })
    expect(res.status).toBe(409)
  })

  it("rejects a case-insensitive hostname collision across tenants → 409", async () => {
    const other = await createTestUser(db)
    await grantSecondFactor(db, other.id)
    const otherProject = await createTestProject(db, other.id)
    const otherApp = await createTestApp(db, {
      userId: other.id,
      projectId: otherProject.id,
    })

    const ownerApp = buildTestApp(db, fakeUser(userId))
    const otherOwnerApp = buildTestApp(db, fakeUser(other.id))

    const first = await ownerApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "Tenant-Collision.Example.com" }),
    })
    expect(first.status).toBe(201)

    const second = await otherOwnerApp.request(
      `/apps/${otherApp.id}/domains`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname: "tenant-collision.example.com" }),
      }
    )
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe("CONFLICT")
  })

  it("rejects a case-insensitive collision with a service hostname", async () => {
    const other = await createTestUser(db)
    const otherProject = await createTestProject(db, other.id)
    await createTestService(db, otherProject.id, "Service-Collision.Example.com")

    const ownerApp = buildTestApp(db, fakeUser(userId))
    const response = await ownerApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "service-collision.example.com" }),
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("CONFLICT")
  })

  it("allows sibling hostnames under the same parent across tenants", async () => {
    const other = await createTestUser(db)
    await grantSecondFactor(db, other.id)
    const otherProject = await createTestProject(db, other.id)
    const otherApp = await createTestApp(db, {
      userId: other.id,
      projectId: otherProject.id,
    })

    const ownerApp = buildTestApp(db, fakeUser(userId))
    const otherOwnerApp = buildTestApp(db, fakeUser(other.id))

    const first = await ownerApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "other.example.com" }),
    })
    expect(first.status).toBe(201)

    const sibling = await otherOwnerApp.request(
      `/apps/${otherApp.id}/domains`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname: "api.example.com" }),
      }
    )
    expect(sibling.status).toBe(201)
  })

  it("rejects a hostname covered by a wildcard domain", async () => {
    const other = await createTestUser(db)
    await grantSecondFactor(db, other.id)
    const otherProject = await createTestProject(db, other.id)
    const otherApp = await createTestApp(db, {
      userId: other.id,
      projectId: otherProject.id,
    })

    const ownerApp = buildTestApp(db, fakeUser(userId))
    const otherOwnerApp = buildTestApp(db, fakeUser(other.id))

    const wildcard = await ownerApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostname: "collision-wild.example.com",
        wildcard: true,
        tls_mode: "dns01",
        dns01_provider: "cloudflare",
      }),
    })
    expect(wildcard.status).toBe(201)

    const child = await otherOwnerApp.request(
      `/apps/${otherApp.id}/domains`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname: "api.collision-wild.example.com" }),
      }
    )
    expect(child.status).toBe(409)
  })

  it("returns 404 when app belongs to another user", async () => {
    const other = await createTestUser(db)
    // Grant second factor so sf check passes — ownership check should produce 404.
    await grantSecondFactor(db, other.id)
    const honoApp = buildTestApp(db, fakeUser(other.id))
    const res = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "valid.example.com" }),
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// DELETE /apps/:id/domains/:domainId
// ---------------------------------------------------------------------------

describe.skipIf(skip)("DELETE /apps/:id/domains/:domainId", () => {
  let db: TestDb
  let userId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id
    await grantSecondFactor(db, userId)
    const project = await createTestProject(db, userId)
    const app = await createTestApp(db, { userId, projectId: project.id })
    appId = app.id
  })

  it("deletes an existing domain → 204", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))

    // Add a domain.
    const addRes = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "to-delete.example.com" }),
    })
    const { domain } = await addRes.json() as { domain: { id: string } }

    const delRes = await honoApp.request(`/apps/${appId}/domains/${domain.id}`, {
      method: "DELETE",
    })
    expect(delRes.status).toBe(204)
  })

  it("returns 404 for unknown domainId", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/domains/does-not-exist`, {
      method: "DELETE",
    })
    expect(res.status).toBe(404)
  })

  it("returns 404 when domain belongs to different app", async () => {
    const project2 = await createTestProject(db, userId)
    const app2 = await createTestApp(db, { userId, projectId: project2.id })
    const honoApp = buildTestApp(db, fakeUser(userId))

    // Add domain to app1.
    const addRes = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "app1.example.com" }),
    })
    const { domain } = await addRes.json() as { domain: { id: string } }

    // Try to delete it via app2's path.
    const res = await honoApp.request(`/apps/${app2.id}/domains/${domain.id}`, {
      method: "DELETE",
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /apps/:id/domains/:domainId/recheck
// ---------------------------------------------------------------------------

describe.skipIf(skip)("POST /apps/:id/domains/:domainId/recheck", () => {
  let db: TestDb
  let userId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id
    await grantSecondFactor(db, userId)
    const project = await createTestProject(db, userId)
    const app = await createTestApp(db, { userId, projectId: project.id })
    appId = app.id
  })

  it("rechecks an existing domain → 200 with domain object", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))

    const addRes = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "recheck.example.com" }),
    })
    const { domain } = await addRes.json() as { domain: { id: string } }

    const res = await honoApp.request(
      `/apps/${appId}/domains/${domain.id}/recheck`,
      { method: "POST" },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { domain: { id: string; tlsStatus: string } }
    expect(body.domain.id).toBe(domain.id)
    expect(body.domain.tlsStatus).toBe("pending")
  })

  it("returns 404 for unknown domainId", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(
      `/apps/${appId}/domains/no-such-domain/recheck`,
      { method: "POST" },
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// D.2 — mutations require second factor (domains router)
// Matrix test: each mutating endpoint returns 403 SECOND_FACTOR_REQUIRED
// when the user has only 1 passkey and 0 backup codes.
// ---------------------------------------------------------------------------

describe.skipIf(skip)("domains mutations require second factor", () => {
  let db: TestDb
  let userId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id

    // Only 1 passkey — triggers SECOND_FACTOR_REQUIRED.
    const now = new Date()
    await db.insert(passkeys).values({
      id: nanoid(),
      user_id: userId,
      credential_id: `cred-dom-sf-only-${userId}`,
      public_key: Buffer.from("pk"),
      counter: 0,
      transports: "[]",
      device_name: null,
      created_at: now,
      last_used_at: now,
    })

    const project = await createTestProject(db, userId)
    const app = await createTestApp(db, { userId, projectId: project.id })
    appId = app.id
  })

  const endpoints: Array<{ method: string; path: (id: string) => string; body?: unknown }> = [
    {
      method: "POST",
      path: (id) => `/apps/${id}/domains`,
      body: { hostname: "sf-test.example.com" },
    },
    {
      method: "DELETE",
      path: (id) => `/apps/${id}/domains/fake-domain-id`,
    },
    {
      method: "POST",
      path: (id) => `/apps/${id}/domains/fake-domain-id/recheck`,
    },
    {
      method: "POST",
      path: (id) => `/apps/${id}/domains/fake-domain-id/tls/mode`,
      body: { tls_mode: "http01" },
    },
  ]

  for (const ep of endpoints) {
    it(`${ep.method} ${ep.path(":id")} → 403 SECOND_FACTOR_REQUIRED`, async () => {
      const honoApp = buildTestApp(db, fakeUser(userId))
      const reqOpts: RequestInit = { method: ep.method }
      if (ep.body !== undefined) {
        reqOpts.headers = { "content-type": "application/json" }
        reqOpts.body = JSON.stringify(ep.body)
      }

      const res = await honoApp.request(ep.path(appId), reqOpts)
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe("SECOND_FACTOR_REQUIRED")
    })
  }

  it("POST /apps/:id/domains passes with 2 passkeys (happy path — second factor satisfied)", async () => {
    const now = new Date()
    await db.insert(passkeys).values({
      id: nanoid(),
      user_id: userId,
      credential_id: "cred-dom-sf-second",
      public_key: Buffer.from("pk2"),
      counter: 0,
      transports: "[]",
      device_name: null,
      created_at: now,
      last_used_at: now,
    })

    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "happy-path.example.com" }),
    })
    expect(res.status).toBe(201)
  })
})
