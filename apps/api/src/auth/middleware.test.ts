// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from "bun:test"
import { createHash } from "node:crypto"
import { Hono } from "hono"
import { requireAuth, requireSecondFactor, requireRole } from "./middleware"
import { requireScope } from "./require-scope"
import {
  signAccessToken,
  buildCookieStr,
  ACCESS_COOKIE,
  ACCESS_MAX_AGE,
} from "./jwt"
import {
  users,
  passkeys,
  backup_codes,
  totp_secrets,
  api_tokens,
  sessions,
} from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { nanoid } from "nanoid"
import { makeTestDb, TEST_PG_URL } from "../test/db-helpers"

const skip = !TEST_PG_URL
if (skip)
  console.log("[middleware.test] PLOYDOK_TEST_PG_URL not set — skipping")

async function insertActiveSession(
  db: Db,
  userId: string,
  sessionId: string
) {
  const now = new Date()
  await db.insert(sessions).values({
    id: sessionId,
    user_id: userId,
    refresh_token_hash: `hash-${sessionId}`,
    user_agent: "test",
    ip: "127.0.0.1",
    created_at: now,
    last_seen_at: now,
    revoked_at: null,
    expires_at: new Date(now.getTime() + 60_000),
  })
}

type FakeSessionRow = {
  id: string
  user_id: string
  revoked_at: Date | null
  expires_at: Date
}

type FakeUserRow = {
  id: string
  email: string
  display_name: string
}

function makeRequireAuthDb(opts: {
  session: FakeSessionRow | null
  user: FakeUserRow | null
}): Db {
  const db = {
    select: () => {
      let table: unknown
      const chain = {
        from(nextTable: unknown) {
          table = nextTable
          return chain
        },
        where() {
          return chain
        },
        limit: async () => {
          if (table === sessions) return opts.session ? [opts.session] : []
          if (table === users) return opts.user ? [opts.user] : []
          return []
        },
      }
      return chain
    },
  }

  return db as unknown as Db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requireAuth session state", () => {
  it("rejects a valid JWT when its session is revoked", async () => {
    const userId = "revoked-user"
    const sessionId = "revoked-session"
    const token = await signAccessToken({
      userId,
      email: "revoked@example.com",
      sessionId,
    })
    const db = makeRequireAuthDb({
      session: {
        id: sessionId,
        user_id: userId,
        revoked_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
      },
      user: {
        id: userId,
        email: "revoked@example.com",
        display_name: "Revoked User",
      },
    })

    const app = new Hono()
    app.get("/protected", requireAuth(db), (c) => c.json({ ok: true }))

    const res = await app.request("/protected", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Session expired or revoked",
      },
    })
  })

  it("rejects a valid JWT when its session row is expired", async () => {
    const userId = "expired-user"
    const sessionId = "expired-session"
    const token = await signAccessToken({
      userId,
      email: "expired@example.com",
      sessionId,
    })
    const db = makeRequireAuthDb({
      session: {
        id: sessionId,
        user_id: userId,
        revoked_at: null,
        expires_at: new Date(Date.now() - 60_000),
      },
      user: {
        id: userId,
        email: "expired@example.com",
        display_name: "Expired User",
      },
    })

    const app = new Hono()
    app.get("/protected", requireAuth(db), (c) => c.json({ ok: true }))

    const res = await app.request("/protected", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Session expired or revoked",
      },
    })
  })
})

describe.skipIf(skip)("requireAuth middleware", () => {
  let db: Db
  let userId: string
  let sessionId: string

  beforeEach(async () => {
    const result = await makeTestDb()
    db = result.db
    userId = `mw-${nanoid(6)}`
    sessionId = `s-${nanoid(6)}`
    const now = new Date()
    await db
      .insert(users)
      .values({
        id: userId,
        email: `user-${userId}@test.com`,
        display_name: "Test User",
        created_at: now,
        updated_at: now,
        recovery_token_hash: null,
        recovery_expires_at: null,
      })
      .onConflictDoNothing()
  })

  it("returns 401 without cookie", async () => {
    const app = new Hono()
    app.get("/protected", requireAuth(db), (c) => c.json({ ok: true }))

    const res = await app.request("/protected")
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("UNAUTHENTICATED")
  })

  it("returns 200 with valid access token cookie", async () => {
    await insertActiveSession(db, userId, sessionId)
    const token = await signAccessToken({
      userId,
      email: `user-${userId}@test.com`,
      sessionId,
    })

    const app = new Hono()
    app.get("/protected", requireAuth(db), (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (c as any).get("user") as { id: string }
      return c.json({ ok: true, userId: user.id })
    })

    const res = await app.request("/protected", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; userId: string }
    expect(body.ok).toBe(true)
    expect(body.userId).toBe(userId)
  })

  it("returns 401 with tampered token", async () => {
    const token = await signAccessToken({
      userId,
      email: "x@x.com",
      sessionId,
    })
    const parts = token.split(".")
    parts[1] = "tampered"
    const bad = parts.join(".")

    const app = new Hono()
    app.get("/protected", requireAuth(db), (c) => c.json({ ok: true }))

    const res = await app.request("/protected", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(bad)}` },
    })
    expect(res.status).toBe(401)
  })

  it("returns 200 with valid PAT bearer and exposes token scopes", async () => {
    const token = `plk_live_${nanoid(16)}`
    await db.insert(api_tokens).values({
      id: `pat-${nanoid(8)}`,
      user_id: userId,
      name: "deploy token",
      token_hash: createHash("sha256").update(token).digest("hex"),
      bcrypt_hash: null,
      scopes: ["apps:deploy"],
      created_at: new Date(),
    })

    const app = new Hono()
    app.get("/protected", requireAuth(db), (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (c as any).get("user")
      return c.json({ ok: true, user })
    })

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      user: { id: string; token_scopes?: string[]; pat_id?: string }
    }
    expect(body.ok).toBe(true)
    expect(body.user.id).toBe(userId)
    expect(body.user.token_scopes).toEqual(["apps:deploy"])
    expect(body.user.pat_id).toBeTruthy()
  })

  it("returns 401 with invalid PAT bearer", async () => {
    const app = new Hono()
    app.get("/protected", requireAuth(db), (c) => c.json({ ok: true }))

    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer plk_live_invalid-token" },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("UNAUTHENTICATED")
  })
})

describe.skipIf(skip)("requireScope middleware", () => {
  let db: Db
  let userId: string

  beforeEach(async () => {
    const result = await makeTestDb()
    db = result.db
    userId = `scope-${nanoid(6)}`
    const now = new Date()
    await db.insert(users).values({
      id: userId,
      email: `user-${userId}@test.com`,
      display_name: "Scope User",
      created_at: now,
      updated_at: now,
      recovery_token_hash: null,
      recovery_expires_at: null,
    })
  })

  async function createPat(scopes: string[]) {
    const token = `plk_live_${nanoid(16)}`
    await db.insert(api_tokens).values({
      id: `pat-${nanoid(8)}`,
      user_id: userId,
      name: "scoped token",
      token_hash: createHash("sha256").update(token).digest("hex"),
      bcrypt_hash: null,
      scopes,
      created_at: new Date(),
    })
    return token
  }

  it("returns 403 when PAT lacks the required scope", async () => {
    const token = await createPat(["apps:read"])
    const app = new Hono()
    app.get(
      "/deploy",
      requireAuth(db),
      requireScope("apps:deploy"),
      (c) => c.json({ ok: true })
    )

    const res = await app.request("/deploy", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("FORBIDDEN")
  })

  it("returns 200 when PAT has the required scope", async () => {
    const token = await createPat(["apps:deploy"])
    const app = new Hono()
    app.get(
      "/deploy",
      requireAuth(db),
      requireScope("apps:deploy"),
      (c) => c.json({ ok: true })
    )

    const res = await app.request("/deploy", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})

describe.skipIf(skip)("requireSecondFactor middleware", () => {
  let db: Db
  let userId: string
  let sessionId: string

  beforeEach(async () => {
    const result = await makeTestDb()
    db = result.db
    userId = `sf-${nanoid(6)}`
    sessionId = `s-${nanoid(6)}`
    const now = new Date()
    await db
      .insert(users)
      .values({
        id: userId,
        email: `user-${userId}@test.com`,
        display_name: "Test User",
        created_at: now,
        updated_at: now,
        recovery_token_hash: null,
        recovery_expires_at: null,
      })
      .onConflictDoNothing()
  })

  async function makeApp() {
    await insertActiveSession(db, userId, sessionId)
    const token = await signAccessToken({
      userId,
      email: `user-${userId}@test.com`,
      sessionId,
    })
    const app = new Hono()
    app.get("/secure", requireAuth(db), requireSecondFactor(db), (c) =>
      c.json({ ok: true })
    )
    return { app, token }
  }

  it("returns 403 SECOND_FACTOR_REQUIRED when user has 0 passkeys and 0 backup codes", async () => {
    const { app, token } = await makeApp()
    const res = await app.request("/secure", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("SECOND_FACTOR_REQUIRED")
  })

  it("returns 200 when user has >= 2 passkeys", async () => {
    const now = new Date()
    await db.insert(passkeys).values([
      {
        id: nanoid(),
        user_id: userId,
        credential_id: `cred-1-${userId}`,
        public_key: Buffer.from("pk1"),
        counter: 0,
        transports: "[]",
        device_name: "Device 1",
        created_at: now,
        last_used_at: now,
      },
      {
        id: nanoid(),
        user_id: userId,
        credential_id: `cred-2-${userId}`,
        public_key: Buffer.from("pk2"),
        counter: 0,
        transports: "[]",
        device_name: "Device 2",
        created_at: now,
        last_used_at: now,
      },
    ])

    const { app, token } = await makeApp()
    const res = await app.request("/secure", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(res.status).toBe(200)
  })

  it("returns 200 when user has 1 passkey + 1 backup code", async () => {
    const now = new Date()
    await db.insert(passkeys).values({
      id: nanoid(),
      user_id: userId,
      credential_id: `cred-3-${userId}`,
      public_key: Buffer.from("pk3"),
      counter: 0,
      transports: "[]",
      device_name: null,
      created_at: now,
      last_used_at: now,
    })
    await db.insert(backup_codes).values({
      id: nanoid(),
      user_id: userId,
      code_hash: "fakehash",
      consumed_at: null,
      created_at: now,
    })

    const { app, token } = await makeApp()
    const res = await app.request("/secure", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(res.status).toBe(200)
  })

  it("returns 200 when user has TOTP verified (no passkeys, no backup codes)", async () => {
    const now = new Date()
    await db.insert(totp_secrets).values({
      id: nanoid(),
      user_id: userId,
      secret_encrypted: JSON.stringify({ enc: "dGVzdA==", nonce: "bm9uY2U=" }),
      verified_at: now,
      created_at: now,
    })

    const { app, token } = await makeApp()
    const res = await app.request("/secure", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(res.status).toBe(200)
  })

  it("returns 403 when user has TOTP enrolled but not yet verified", async () => {
    const now = new Date()
    await db.insert(totp_secrets).values({
      id: nanoid(),
      user_id: userId,
      secret_encrypted: JSON.stringify({ enc: "dGVzdA==", nonce: "bm9uY2U=" }),
      verified_at: null,
      created_at: now,
    })

    const { app, token } = await makeApp()
    const res = await app.request("/secure", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("SECOND_FACTOR_REQUIRED")
  })
})

describe.skipIf(skip)("requireRole middleware", () => {
  let db: Db
  let userId: string
  let sessionId: string
  let orgId: string

  beforeEach(async () => {
    const result = await makeTestDb()
    db = result.db
    userId = `role-${nanoid(6)}`
    sessionId = `s-${nanoid(6)}`
    orgId = `org-${nanoid(6)}`
    const now = new Date()

    // Create user
    await db
      .insert(users)
      .values({
        id: userId,
        email: `user-${userId}@test.com`,
        display_name: "Test User",
        created_at: now,
        updated_at: now,
        recovery_token_hash: null,
        recovery_expires_at: null,
      })
      .onConflictDoNothing()

    // Create org
    const { projects } = await import("@ploydok/db")
    await db
      .insert(projects)
      .values({
        id: orgId,
        owner_id: userId,
        name: "Test Org",
        slug: `org-${orgId}`,
        created_at: now,
      })
      .onConflictDoNothing()

    await insertActiveSession(db, userId, sessionId)
  })

  it("returns 401 without auth", async () => {
    const app = new Hono()
    app.get("/protected/:orgId", requireRole(db, ["owner"]), (c) =>
      c.json({ ok: true })
    )

    const res = await app.request(`/protected/${orgId}`)
    expect(res.status).toBe(401)
  })

  it("returns 403 when user has no membership", async () => {
    const token = await signAccessToken({
      userId,
      email: `user-${userId}@test.com`,
      sessionId,
    })
    const otherOrgId = `other-${nanoid(6)}`
    // The org must exist: a missing org is a 404 by contract, not a 403.
    const { projects: otherProjects } = await import("@ploydok/db")
    await db
      .insert(otherProjects)
      .values({
        id: otherOrgId,
        owner_id: userId,
        name: "Other Org",
        slug: `org-${otherOrgId}`,
        created_at: new Date(),
      })
      .onConflictDoNothing()

    const app = new Hono()
    app.get(
      "/protected/:orgId",
      requireAuth(db),
      requireRole(db, ["owner"]),
      (c) => c.json({ ok: true })
    )

    const res = await app.request(`/protected/${otherOrgId}`, {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(res.status).toBe(403)
  })

  it("returns 200 when user has required role", async () => {
    const token = await signAccessToken({
      userId,
      email: `user-${userId}@test.com`,
      sessionId,
    })
    const { memberships } = await import("@ploydok/db")
    const now = new Date()

    // Add membership with owner role
    await db
      .insert(memberships)
      .values({
        id: nanoid(),
        org_id: orgId,
        user_id: userId,
        role: "owner",
        invited_at: now,
        accepted_at: now,
      })
      .onConflictDoNothing()

    const app = new Hono()
    app.get(
      "/protected/:orgId",
      requireAuth(db),
      requireRole(db, ["owner"]),
      (c) => c.json({ ok: true })
    )

    const res = await app.request(`/protected/${orgId}`, {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(res.status).toBe(200)
  })

  it("returns 403 when user has wrong role", async () => {
    const token = await signAccessToken({
      userId,
      email: `user-${userId}@test.com`,
      sessionId,
    })
    const { memberships } = await import("@ploydok/db")
    const now = new Date()

    // Add membership with member role (not owner)
    await db
      .insert(memberships)
      .values({
        id: nanoid(),
        org_id: orgId,
        user_id: userId,
        role: "member",
        invited_at: now,
        accepted_at: now,
      })
      .onConflictDoNothing()

    const app = new Hono()
    app.get(
      "/protected/:orgId",
      requireAuth(db),
      requireRole(db, ["owner"]),
      (c) => c.json({ ok: true })
    )

    const res = await app.request(`/protected/${orgId}`, {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(res.status).toBe(403)
  })
})
