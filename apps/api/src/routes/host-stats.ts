// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import { z } from "zod"
import { buildHostStatsBody } from "../observability/host-stats-body"
import {
  hostStatsLive,
  type HostStatsLive,
} from "../observability/host-stats-live"
import { eq, inArray, and } from "drizzle-orm"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"
import type { AuthUser } from "../auth/middleware"
import type { Db } from "@ploydok/db"
import { memberships } from "@ploydok/db"

const log = childLogger("host-stats.routes")

type AppEnv = { Variables: { user?: AuthUser } }

async function isUserAdmin(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.user_id, userId), inArray(memberships.role, ["owner"]))
    )
    .limit(1)

  return rows.length > 0
}

export function createHostStatsRouter(
  db: Db,
  live: HostStatsLive = hostStatsLive
): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get("/", async (c) => {
    const user = c.get("user") as AuthUser | undefined
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    const isAdmin = await isUserAdmin(db, user.id)
    if (!isAdmin) {
      return c.json({ error: "admin_required" }, 403)
    }

    try {
      const cached = live.freshSnapshot()
      if (cached) return c.json(cached)
      const r = await getSharedAgent().hostStats({}, 5000)
      const body = buildHostStatsBody(r, Date.now())
      return c.json(body)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "agent error"
      log.warn({ err: msg }, "host_stats.failed")
      return c.json(
        {
          error: { code: "AGENT_UNAVAILABLE", message: msg },
        },
        503
      )
    }
  })

  const watchBody = z.object({ clientId: z.string().min(8).max(64) })
  router.on(["POST", "DELETE"], "/watch", async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "Unauthorized" }, 401)
    if (!(await isUserAdmin(db, user.id))) {
      return c.json({ error: "admin_required" }, 403)
    }
    const parsed = watchBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid_client_id" }, 400)
    if (c.req.method === "DELETE") {
      live.release(user.id, parsed.data.clientId)
      return c.body(null, 204)
    }
    live.renew(user.id, parsed.data.clientId)
    return c.json({ intervalMs: 2000, leaseMs: 45000 })
  })

  return router
}
