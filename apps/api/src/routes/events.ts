// SPDX-License-Identifier: AGPL-3.0-only
//
// SSE notification stream — GET /events
//
// Auth: requireAuth(db) is mounted in app.ts before this router.
// The user is available via c.get("user").
//
// Stream lifecycle:
//   1. Replay last 20 events for channel user:{userId}, filtered by the
//      persisted last_read_at cursor so already-read events don't re-inflate
//      the client badge after a reconnect.
//   2. Subscribe to live events on the same channel.
//   3. Send a heartbeat ping every HEARTBEAT_INTERVAL_MS.
//   4. On abort: clear heartbeat + unsubscribe.

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { createDb } from "@ploydok/db"
import { getReadState, markNotificationsRead } from "@ploydok/db/queries"
import { eventBus } from "../worker/event-bus"
import { env } from "../env"
import type { AuthUser } from "../auth/middleware"

const db = createDb(env.DATABASE_URL)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Keep this well under Bun.serve's idleTimeout so the TCP socket doesn't get
// truncated between events (ERR_INCOMPLETE_CHUNKED_ENCODING). Bun's default is
// 10 s; even when the server disables it via idleTimeout: 0, intermediate
// proxies (Caddy, browser dev tools) still expect activity within ~15 s.
const HEARTBEAT_INTERVAL_MS = 8_000
const REPLAY_LIMIT = 20

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const eventsRouter = new Hono<{ Variables: { user?: AuthUser } }>()

// GET / — SSE stream for the authenticated user
eventsRouter.get("/", async (c) => {
  const user = c.get("user") as AuthUser | undefined

  if (!user) {
    return c.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
      401,
    )
  }

  const channel = `user:${user.id}`
  const lastReadAt = await getReadState(db, user.id)
  const cursorMs = lastReadAt?.getTime() ?? 0

  return streamSSE(c, async (stream) => {
    // Flush an SSE comment immediately so browsers/proxies consider the stream
    // established even when there is no replayed notification to send.
    await stream.write(": connected\n\n")

    // 1. Replay buffered history, skipping events already covered by the
    // persisted last_read_at cursor. Prevents the badge from re-inflating on
    // every SSE reconnect while still letting the client dedup by id if the
    // same event arrives again via the live subscription. Replayed events carry
    // `replay: true` so data-refresh consumers can ignore stale history.
    const history = eventBus.replay(channel, REPLAY_LIMIT)
    for (const event of history) {
      if (event.t <= cursorMs) continue
      await stream.writeSSE({
        data: JSON.stringify({ ...event, replay: true }),
        event: event.type,
        id: event.id,
      })
    }

    // 2. Subscribe to live events.
    const unsubscribe = eventBus.subscribe(channel, (event) => {
      stream
        .writeSSE({
          data: JSON.stringify(event),
          event: event.type,
          id: event.id,
        })
        .catch(() => {
          // Stream may have closed — subscriber will be cleaned up via onAbort.
        })
    })

    // 3. Heartbeat every HEARTBEAT_INTERVAL_MS.
    const hb = setInterval(() => {
      stream
        .writeSSE({ event: "ping", data: String(Date.now()) })
        .catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)

    // 4. Cleanup on disconnect — also resolves the open promise so the handler returns.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(hb)
        unsubscribe()
        resolve()
      })
    })
  })
})

// ---------------------------------------------------------------------------
// GET /events/read-state — last_read_at cursor for the notification bell.
// ---------------------------------------------------------------------------

eventsRouter.get("/read-state", async (c) => {
  const user = c.get("user") as AuthUser | undefined
  if (!user) {
    return c.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
      401,
    )
  }
  const lastReadAt = await getReadState(db, user.id)
  return c.json({
    lastReadAt: lastReadAt?.toISOString() ?? null,
  })
})

// ---------------------------------------------------------------------------
// POST /events/mark-read — bumps last_read_at to the supplied timestamp
// (defaults to "now"). The bell calls this whenever its dropdown closes.
// ---------------------------------------------------------------------------

const MarkReadBody = z.object({
  at: z.string().datetime().optional(),
})

eventsRouter.post("/mark-read", async (c) => {
  const user = c.get("user") as AuthUser | undefined
  if (!user) {
    return c.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
      401,
    )
  }
  const raw = await c.req.json().catch(() => ({}))
  const parsed = MarkReadBody.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "invalid 'at' timestamp" } },
      400,
    )
  }
  const at = parsed.data.at ? new Date(parsed.data.at) : new Date()
  await markNotificationsRead(db, user.id, at)
  return c.json({ lastReadAt: at.toISOString() })
})
