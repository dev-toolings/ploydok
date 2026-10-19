// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, mock } from "bun:test"
import { Hono } from "hono"
import { nanoid } from "nanoid"
import {
  users,
  projects,
  memberships,
  apps,
  audit_log,
  webhook_deliveries,
} from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { makeTestDb as makePgTestDb, TEST_PG_URL } from "../test/db-helpers"
import { createAppsRouter } from "./apps"
import type { AuthUser } from "../auth/middleware"
import { createHmac } from "node:crypto"

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock encryptField to return deterministic nonce+enc so tests don't need a keyring.
mock.module("../github/app-credentials", () => ({
  encryptField: mock(async (plaintext: string) => {
    const nonce = Buffer.alloc(12, 0xab)
    const enc = Buffer.from(plaintext, "utf-8")
    return { nonce, enc }
  }),
  decryptField: mock(async (enc: Buffer, _nonce: Buffer) => {
    return enc.toString("utf-8")
  }),
}))

// Mock requireTotpVerified so we can control whether TOTP passes or fails per test.
let totpShouldPass = true

mock.module("../auth/second-factor", () => ({
  requireTotpVerified: mock((_db: unknown) => {
    return async (c: unknown, next: () => Promise<void>) => {
      if (!totpShouldPass) {
        return (c as { json: (body: unknown, status: number) => unknown }).json(
          { code: "totp_required", message: "Second factor required" },
          403
        )
      }
      return next()
    }
  }),
  buildSecondFactorCookie: mock(() => ""),
  SECOND_FACTOR_COOKIE: "ploydok_2fa_verified",
}))

// Mock requireSecondFactor to always pass in tests (no passkey/TOTP setup in test DB).
mock.module("../auth/middleware", () => ({
  requireSecondFactor: mock((_db: unknown) => {
    return async (_c: unknown, next: () => Promise<void>) => next()
  }),
  requireAuth: mock(
    () => async (_c: unknown, next: () => Promise<void>) => next()
  ),
  getUser: mock((c: unknown) =>
    (c as { get: (k: string) => unknown }).get("user")
  ),
}))

// ---------------------------------------------------------------------------
// Skip if no test DB
// ---------------------------------------------------------------------------

const skip = !TEST_PG_URL
if (skip)
  console.log("[apps-webhooks.test] PLOYDOK_TEST_PG_URL not set — skipping")

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function makeTestDb() {
  const { db } = await makePgTestDb()
  return db
}

type TestDb = Db

async function createTestUser(
  db: TestDb,
  overrides: Partial<{ id: string; email: string }> = {}
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
  projectId: string,
  overrides: Partial<{ id: string }> = {}
) {
  const id = overrides.id ?? nanoid()
  const slug = `app-${id.slice(0, 8)}`
  const now = new Date()
  await db.insert(apps).values({
    id,
    project_id: projectId,
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

async function insertDelivery(
  db: TestDb,
  appId: string,
  overrides: Partial<typeof webhook_deliveries.$inferInsert> = {}
) {
  const id = nanoid()
  await db.insert(webhook_deliveries).values({
    id,
    app_id: appId,
    provider: "github",
    event: "push",
    ref: "refs/heads/main",
    commit_sha: "abc123",
    commit_message: "test commit",
    signature_valid: true,
    decision: "enqueued",
    decision_reason: null,
    build_id: null,
    payload_hash: "hash-" + id,
    payload_sample: null,
    payload_raw: null,
    received_at: new Date(),
    ...overrides,
  })
  return id
}

function buildTestApp(db: TestDb, authedUser?: AuthUser): Hono {
  const honoApp = new Hono()
  honoApp.use("*", async (c, next) => {
    if (authedUser) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(c as any).set("user", authedUser)
    }
    return next()
  })
  const router = createAppsRouter(db)
  honoApp.route("/apps", router)
  return honoApp
}

function fakeUser(id: string): AuthUser {
  return {
    id,
    email: `${id}@test.com`,
    display_name: "Test User",
    session_id: "sess-test",
  }
}

// ---------------------------------------------------------------------------
// GET /apps/:id/webhook-deliveries
// ---------------------------------------------------------------------------

describe.skipIf(skip)("GET /apps/:id/webhook-deliveries", () => {
  let db: TestDb
  let userId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id
    const project = await createTestProject(db, userId)
    const appResult = await createTestApp(db, project.id)
    appId = appResult.id
  })

  it("returns 200 with deliveries for owned app", async () => {
    const payloadSample = { ref: "refs/heads/main" }
    const deliveryId = await insertDelivery(db, appId, {
      payload_sample: payloadSample,
    })
    const honoApp = buildTestApp(db, fakeUser(userId))

    const res = await honoApp.request(`/apps/${appId}/webhook-deliveries`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      deliveries: Array<{ id: string; payload_sample: unknown }>
      next_cursor: string | null
    }
    expect(Array.isArray(body.deliveries)).toBe(true)
    expect(body.deliveries.length).toBeGreaterThanOrEqual(1)
    const found = body.deliveries.find((d) => d.id === deliveryId)
    expect(found).toBeTruthy()
    expect(found?.payload_sample).toEqual(payloadSample)
  })

  it("returns 200 with pagination cursor when more items exist", async () => {
    // Insert 3 deliveries with distinct timestamps
    for (let i = 0; i < 3; i++) {
      await insertDelivery(db, appId, {
        received_at: new Date(Date.now() - i * 1000),
      })
    }
    const honoApp = buildTestApp(db, fakeUser(userId))

    const res = await honoApp.request(
      `/apps/${appId}/webhook-deliveries?limit=2`
    )
    const body = (await res.json()) as {
      deliveries: unknown[]
      next_cursor: string | null
    }
    expect(body.deliveries.length).toBe(2)
    expect(body.next_cursor).not.toBeNull()
  })

  it("returns 404 if the user does not own the app", async () => {
    const otherUser = await createTestUser(db)
    const honoApp = buildTestApp(db, fakeUser(otherUser.id))

    const res = await honoApp.request(`/apps/${appId}/webhook-deliveries`)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /apps/:id/webhook-deliveries/:deliveryId
// ---------------------------------------------------------------------------

describe.skipIf(skip)("GET /apps/:id/webhook-deliveries/:deliveryId", () => {
  let db: TestDb
  let userId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id
    const project = await createTestProject(db, userId)
    const appResult = await createTestApp(db, project.id)
    appId = appResult.id
  })

  it("returns delivery detail with id", async () => {
    const deliveryId = await insertDelivery(db, appId)
    const honoApp = buildTestApp(db, fakeUser(userId))

    const res = await honoApp.request(
      `/apps/${appId}/webhook-deliveries/${deliveryId}`
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      delivery: { id: string; payload_sample: unknown }
    }
    expect(body.delivery.id).toBe(deliveryId)
  })

  it("returns 404 for unknown delivery", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(
      `/apps/${appId}/webhook-deliveries/nonexistent`
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// PATCH /apps/:id — webhook toggle fields
// ---------------------------------------------------------------------------

describe.skipIf(skip)("PATCH /apps/:id — webhook toggles", () => {
  let db: TestDb
  let userId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id
    const project = await createTestProject(db, userId)
    const appResult = await createTestApp(db, project.id)
    appId = appResult.id

    // Set up second-factor mock — for PATCH the route uses requireSecondFactor (sf), not TOTP
    // We test the sf middleware separately; here we bypass it via the test bypass pattern
    // by using PLOYDOK_DEBUG_UNAUTHENTICATED approach. Instead, we mock the singletons.
  })

  it("updates webhook toggle fields in DB", async () => {
    // Use the CI bypass pattern — rebuild app without sf middleware by calling
    // the router directly with a user already set. SF middleware checks c.get("user")
    // then validates the second-factor cookie. In tests, we skip it by not applying sf.
    // We rely on the fact that requireSecondFactor is just `requireSecondFactor(db)` —
    // the router doesn't enforce it during test because there's no second-factor cookie.
    // Workaround: mock requireSecondFactor as pass-through.
    // Note: bun mock.module is process-wide; we declared it above.

    // For PATCH, the existing test pattern from apps.test.ts shows it always succeeds
    // because `requireSecondFactor` passes if there's no TOTP enrolled.
    const honoApp = buildTestApp(db, fakeUser(userId))

    const res = await honoApp.request(`/apps/${appId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auto_deploy_enabled: false,
        post_commit_status: false,
        coalesce_pushes: false,
        deploy_on_tag: true,
        tag_pattern: "^v\\d+\\.\\d+\\.\\d+$",
      }),
    })
    expect(res.status).toBe(200)

    const { eq } = await import("drizzle-orm")
    const { apps: appsTable } = await import("@ploydok/db")
    const rows = await db
      .select()
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
    const row = rows[0]!
    expect(row.auto_deploy_enabled).toBe(false)
    expect(row.post_commit_status).toBe(false)
    expect(row.coalesce_pushes).toBe(false)
    expect(row.deploy_on_tag).toBe(true)
    expect(row.tag_pattern).toBe("^v\\d+\\.\\d+\\.\\d+$")
  })

  it("rejects invalid tag_pattern (not a valid regex)", async () => {
    const honoApp = buildTestApp(db, fakeUser(userId))

    const res = await honoApp.request(`/apps/${appId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag_pattern: "[invalid" }),
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /apps/:id/webhook-secret/rotate
// ---------------------------------------------------------------------------

describe.skipIf(skip)("POST /apps/:id/webhook-secret/rotate", () => {
  let db: TestDb
  let userId: string
  let appId: string

  beforeEach(async () => {
    db = await makeTestDb()
    const user = await createTestUser(db)
    userId = user.id
    const project = await createTestProject(db, userId)
    const appResult = await createTestApp(db, project.id)
    appId = appResult.id
    totpShouldPass = true
  })

  it("returns 403 without TOTP (totp_required)", async () => {
    totpShouldPass = false
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/webhook-secret/rotate`, {
      method: "POST",
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("totp_required")
  })

  it("returns 200 + secret on first rotation with TOTP", async () => {
    totpShouldPass = true
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(`/apps/${appId}/webhook-secret/rotate`, {
      method: "POST",
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { secret: string }
    expect(typeof body.secret).toBe("string")
    expect(body.secret.length).toBeGreaterThan(0)

    // Verify DB was updated
    const { eq } = await import("drizzle-orm")
    const { apps: appsTable } = await import("@ploydok/db")
    const rows = await db
      .select()
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
    const row = rows[0]!
    expect(row.webhook_secret).toBeTruthy()
    expect(row.webhook_secret_old_expires_at).toBeTruthy()
  })

  it("returns 409 if rotation happened < 24h ago", async () => {
    totpShouldPass = true
    const honoApp = buildTestApp(db, fakeUser(userId))

    // First rotation — succeeds
    const res1 = await honoApp.request(`/apps/${appId}/webhook-secret/rotate`, {
      method: "POST",
    })
    expect(res1.status).toBe(200)

    // Set webhook_secret_old so the cooldown check triggers
    // (first rotation moves null → webhook_secret, sets old_expires_at)
    // Second rotation should be blocked because old_expires_at is in the future
    const res2 = await honoApp.request(`/apps/${appId}/webhook-secret/rotate`, {
      method: "POST",
    })
    expect(res2.status).toBe(409)
    const body = (await res2.json()) as { code: string }
    expect(body.code).toBe("rotation_cooldown")
  })

  it("returns 404 for non-existent app", async () => {
    totpShouldPass = true
    const honoApp = buildTestApp(db, fakeUser(userId))
    const res = await honoApp.request(
      `/apps/nonexistent/webhook-secret/rotate`,
      { method: "POST" }
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /apps/:id/webhook-deliveries/:deliveryId/replay
// ---------------------------------------------------------------------------

describe.skipIf(skip)(
  "POST /apps/:id/webhook-deliveries/:deliveryId/replay",
  () => {
    let db: TestDb
    let userId: string
    let appId: string

    beforeEach(async () => {
      db = await makeTestDb()
      const user = await createTestUser(db)
      userId = user.id
      const project = await createTestProject(db, userId)
      const appResult = await createTestApp(db, project.id)
      appId = appResult.id
      totpShouldPass = true
    })

    it("returns 403 when TOTP is missing/invalid", async () => {
      totpShouldPass = false
      const deliveryId = await insertDelivery(db, appId)
      const honoApp = buildTestApp(db, fakeUser(userId))

      const res = await honoApp.request(
        `/apps/${appId}/webhook-deliveries/${deliveryId}/replay`,
        { method: "POST" }
      )
      expect(res.status).toBe(403)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("totp_required")
    })

    it("returns 422 when payload_raw is missing (expired)", async () => {
      totpShouldPass = true
      // Insert delivery without payload_raw (null)
      const deliveryId = await insertDelivery(db, appId, { payload_raw: null })
      const honoApp = buildTestApp(db, fakeUser(userId))

      const res = await honoApp.request(
        `/apps/${appId}/webhook-deliveries/${deliveryId}/replay`,
        { method: "POST" }
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("replay_payload_missing")
    })

    it("returns 429 when replay limit (10) is exceeded", async () => {
      totpShouldPass = true

      // Create a parent delivery with a payload_raw buffer (gzip of valid JSON)
      const rawPayload = Buffer.from(
        JSON.stringify({
          ref: "refs/heads/main",
          repository: { full_name: "owner/repo" },
        })
      )
      const compressed = Bun.gzipSync(
        new Uint8Array(
          rawPayload.buffer,
          rawPayload.byteOffset,
          rawPayload.byteLength
        )
      )
      const parentId = await insertDelivery(db, appId, {
        payload_raw: new Uint8Array(compressed),
      })

      // Insert 10 existing replay deliveries referencing the parent
      for (let i = 0; i < 10; i++) {
        const replayId = nanoid()
        await db.insert(webhook_deliveries).values({
          id: replayId,
          app_id: appId,
          provider: "github",
          event: "push",
          ref: "refs/heads/main",
          commit_sha: "abc123",
          commit_message: "test",
          signature_valid: true,
          decision: "enqueued",
          decision_reason: "replay",
          payload_hash: "hash-replay-" + i,
          payload_sample: null,
          payload_raw: null,
          source: "replay",
          parent_delivery_id: parentId,
          received_at: new Date(),
        })
      }

      const honoApp = buildTestApp(db, fakeUser(userId))
      const res = await honoApp.request(
        `/apps/${appId}/webhook-deliveries/${parentId}/replay`,
        { method: "POST" }
      )
      expect(res.status).toBe(429)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("replay_limit_reached")
    })
  }
)

// ---------------------------------------------------------------------------
// verifySignature dual-accept (GitHub)
// ---------------------------------------------------------------------------

describe("verifySignature dual-accept (GitHub)", () => {
  const body = JSON.stringify({ ref: "refs/heads/main" })
  const currentSecret = "current-secret-xyz"
  const oldSecret = "old-secret-abc"

  function makeGhSig(b: string, secret: string): string {
    return "sha256=" + createHmac("sha256", secret).update(b).digest("hex")
  }

  it("accepts signature from current secret", async () => {
    const { verifySignatureWithFallback } = await import("../github/webhook")
    const sig = makeGhSig(body, currentSecret)
    const result = await verifySignatureWithFallback(
      body,
      sig,
      "global-secret",
      {
        current: Buffer.concat([
          Buffer.alloc(12, 0xab),
          Buffer.from(currentSecret),
        ]),
      }
    )
    expect(result.valid).toBe(true)
    expect(result.usedOldSecret).toBe(false)
  })

  it("accepts signature from non-expired old secret", async () => {
    const { verifySignatureWithFallback } = await import("../github/webhook")
    const sig = makeGhSig(body, oldSecret)
    const futureExpiry = new Date(Date.now() + 60_000)
    const result = await verifySignatureWithFallback(
      body,
      sig,
      "global-secret",
      {
        current: Buffer.concat([
          Buffer.alloc(12, 0xab),
          Buffer.from(currentSecret),
        ]),
        old: Buffer.concat([Buffer.alloc(12, 0xab), Buffer.from(oldSecret)]),
        oldExpiresAt: futureExpiry,
      }
    )
    expect(result.valid).toBe(true)
    expect(result.usedOldSecret).toBe(true)
  })

  it("rejects signature from expired old secret", async () => {
    const { verifySignatureWithFallback } = await import("../github/webhook")
    const sig = makeGhSig(body, oldSecret)
    const pastExpiry = new Date(Date.now() - 1000)
    const result = await verifySignatureWithFallback(
      body,
      sig,
      "global-secret",
      {
        current: Buffer.concat([
          Buffer.alloc(12, 0xab),
          Buffer.from(currentSecret),
        ]),
        old: Buffer.concat([Buffer.alloc(12, 0xab), Buffer.from(oldSecret)]),
        oldExpiresAt: pastExpiry,
      }
    )
    expect(result.valid).toBe(false)
  })

  it("falls back to global secret when no perApp provided", async () => {
    const { verifySignatureWithFallback } = await import("../github/webhook")
    const globalSecret = "global-wh-secret"
    const sig = makeGhSig(body, globalSecret)
    const result = await verifySignatureWithFallback(body, sig, globalSecret)
    expect(result.valid).toBe(true)
    expect(result.usedOldSecret).toBe(false)
  })
})
