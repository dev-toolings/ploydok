// SPDX-License-Identifier: AGPL-3.0-only
import { describe, test, expect, beforeEach } from "bun:test"
import { Hono } from "hono"
import { nanoid } from "nanoid"
import { users } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { makeTestDb as makePgTestDb, TEST_PG_URL } from "../test/db-helpers"
import { signAccessToken, ACCESS_COOKIE } from "../auth/jwt"
import { requireAuth } from "../auth/middleware"
import { eventBus } from "../worker/event-bus"
import { eventsRouter } from "./events"

// ---------------------------------------------------------------------------
// Test DB helper — in-memory SQLite with the users table only
// ---------------------------------------------------------------------------

const skip = !TEST_PG_URL
if (skip) console.log("[events.test] PLOYDOK_TEST_PG_URL not set — skipping")

async function makeTestDb() {
  const { db } = await makePgTestDb()
  return db
}

type TestDb = Db

async function createTestUser(db: TestDb, id = nanoid()) {
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
  return { id, email: `user-${id}@test.com` }
}

// ---------------------------------------------------------------------------
// Test app builder — mounts requireAuth + eventsRouter under /events
// ---------------------------------------------------------------------------

function buildTestApp(db: TestDb) {
  const honoApp = new Hono()
  honoApp.use("/events", requireAuth(db))
  honoApp.route("/events", eventsRouter)
  return honoApp
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeAuthCookie(userId: string, email: string): Promise<string> {
  const token = await signAccessToken({ userId, email, sessionId: `sess-${userId}` })
  return `${ACCESS_COOKIE}=${encodeURIComponent(token)}`
}

/** Collect lines from an SSE Response until `count` data events are received or timeout. */
async function collectSseEvents(
  res: Response,
  count: number,
  timeoutMs = 2_000,
): Promise<string[]> {
  const events: string[] = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""

  const deadline = Date.now() + timeoutMs

  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    // Parse SSE lines: lines starting with "data:" are data events.
    const lines = buf.split("\n")
    buf = lines.pop() ?? "" // keep incomplete last line
    for (const line of lines) {
      if (line.startsWith("data:")) {
        events.push(line.slice("data:".length).trim())
      }
    }
  }

  reader.cancel()
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(skip)("GET /events", () => {
  let db: TestDb

  beforeEach(async () => {
    db = await makeTestDb()
  })

  // -------------------------------------------------------------------------
  // 1. No cookie → 401
  // -------------------------------------------------------------------------
  test("returns 401 without cookie", async () => {
    const app = buildTestApp(db)
    const res = await app.request("/events")
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("UNAUTHENTICATED")
  })

  // -------------------------------------------------------------------------
  // 2. Valid cookie → 200 + text/event-stream
  // -------------------------------------------------------------------------
  test("returns 200 with text/event-stream content-type for valid cookie", async () => {
    const { id: uid, email } = await createTestUser(db)
    const cookie = await makeAuthCookie(uid, email)

    const app = buildTestApp(db)

    const ac = new AbortController()
    const res = await app.request("/events", {
      headers: { cookie },
      signal: ac.signal,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    // Clean up stream
    ac.abort()
    await res.body?.cancel()
  })

  // -------------------------------------------------------------------------
  // 3. Replay: events published before connect are received at connect time
  // -------------------------------------------------------------------------
  test("replays events published before connection", async () => {
    const { id: uid, email } = await createTestUser(db)
    const channel = `user:${uid}`
    const cookie = await makeAuthCookie(uid, email)

    // Publish 2 events before connecting
    eventBus.publish(channel, { type: "build.started", appId: "app-1", message: "Build started" })
    eventBus.publish(channel, { type: "build.succeeded", appId: "app-1", message: "Build done" })

    const app = buildTestApp(db)
    const res = await app.request("/events", { headers: { cookie } })

    expect(res.status).toBe(200)

    const events = await collectSseEvents(res, 2)
    expect(events).toHaveLength(2)

    const first = JSON.parse(events[0]!) as {
      type: string
      message: string
      replay?: boolean
    }
    expect(first.type).toBe("build.started")
    expect(first.replay).toBe(true)
    const second = JSON.parse(events[1]!) as {
      type: string
      message: string
      replay?: boolean
    }
    expect(second.type).toBe("build.succeeded")
    expect(second.replay).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 4. Live: events published after connect are received
  // -------------------------------------------------------------------------
  test("delivers live events published after connection", async () => {
    const { id: uid, email } = await createTestUser(db)
    const channel = `user:${uid}`
    const cookie = await makeAuthCookie(uid, email)

    const app = buildTestApp(db)
    const res = await app.request("/events", { headers: { cookie } })

    expect(res.status).toBe(200)

    // Publish after a short delay to let the subscriber register
    const publishPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        eventBus.publish(channel, { type: "deploy.status_change", appId: "app-2", message: "Deployed" })
        resolve()
      }, 50)
    })

    const [events] = await Promise.all([collectSseEvents(res, 1), publishPromise])

    expect(events).toHaveLength(1)
    const evt = JSON.parse(events[0]!) as { type: string; message: string }
    expect(evt.type).toBe("deploy.status_change")
    expect(evt.message).toBe("Deployed")
  })
})
