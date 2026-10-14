// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import type { Db } from "@ploydok/db"
import {
  getAppForUser,
  listPreviewDeploymentsForApp,
  getPreviewDeploymentByAppAndPr,
} from "@ploydok/db/queries"
import { enqueuePreviewIntent } from "../worker/preview-intents"
import { previewTeardown } from "../worker/queues"
import type { AuthUser } from "../auth/middleware"
import { childLogger } from "../logger"

const log = childLogger("route:apps-previews")

function getUser(c: { get: (key: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

export function createPreviewsRoute(db: Db): Hono {
  const router = new Hono()

  /**
   * GET /apps/:appId/previews — list preview deployments for an app
   */
  router.get("/:appId/previews", async (c) => {
    const user = getUser(c)
    const appId = c.req.param("appId")

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json({ error: "not found" }, 404)
    }

    const previews = await listPreviewDeploymentsForApp(db, appId)
    return c.json(previews)
  })

  /**
   * GET /apps/:appId/previews/:prNumber — get a specific preview deployment
   */
  router.get("/:appId/previews/:prNumber", async (c) => {
    const user = getUser(c)
    const appId = c.req.param("appId")
    const prNumber = parseInt(c.req.param("prNumber"), 10)

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json({ error: "not found" }, 404)
    }

    const preview = await getPreviewDeploymentByAppAndPr(db, appId, prNumber)
    if (!preview) {
      return c.json({ error: "not found" }, 404)
    }

    return c.json(preview)
  })

  /**
   * POST /apps/:appId/previews/:prNumber/teardown — manually teardown a preview
   */
  router.post("/:appId/previews/:prNumber/teardown", async (c) => {
    const user = getUser(c)
    const appId = c.req.param("appId")
    const prNumber = parseInt(c.req.param("prNumber"), 10)

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json({ error: "not found" }, 404)
    }

    log.info({ appId, prNumber, userId: user.id }, "enqueuing preview teardown")

    await enqueuePreviewIntent(db, previewTeardown, {
      action: "teardown", appId, prNumber, source: "api", requestedByUserId: user.id,
    })

    return c.json({ ok: true })
  })

  return router
}
