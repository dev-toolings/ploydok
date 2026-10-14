// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { audit_log } from "@ploydok/db"
import { maskServiceSecrets, revealServiceSecrets } from "../services/service-secrets"
import { createDb } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import {
  listServicesForProject,
  listServicesForOwner,
  getServiceForUser,
  getServiceForOwner,
  hasRole,
} from "@ploydok/db/queries"
import { CreateServiceFromTemplateBody } from "@ploydok/shared"
import { env } from "../env"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"
import type { AuthUser } from "../auth/middleware"
import { requireScope } from "../auth/require-scope"
import {
  installFromTemplate,
  startService,
  stopService,
  deleteService,
} from "../services/marketplace-orchestrator"

const log = childLogger("services.routes")

type AppEnv = { Variables: { user?: AuthUser } }

function getUser(c: { get: (k: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createServicesRouter(db: Db): Hono<any, any, any> {
  const router = new Hono<AppEnv>()
  const ownerOnly: MiddlewareHandler = async (c, next) => {
    const user = getUser(c)
    const svc = await getServiceForOwner(db, c.req.param("id")!, user.id)
    if (!svc) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Service not found" } },
        404
      )
    }
    await next()
  }

  // GET /services?projectId=<id>
  router.get("/", requireScope("services:read"), async (c) => {
    const user = getUser(c)
    const projectId = c.req.query("projectId")

    if (projectId) {
      if (!(await hasRole(db, projectId, user.id, ["owner"]))) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Project not found" } },
          404
        )
      }
      const rows = await listServicesForProject(db, projectId)
      return c.json({ services: rows.map(maskServiceSecrets) })
    }

    // All services across projects the user owns (accepted owner membership)
    const rows = await listServicesForOwner(db, user.id)
    return c.json({ services: rows.map(maskServiceSecrets) })
  })

  // GET /services/:id
  router.get("/:id", requireScope("services:read"), async (c) => {
    const user = getUser(c)
    const svc = await getServiceForUser(db, c.req.param("id")!, user.id)
    if (!svc) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Service not found" } },
        404
      )
    }
    return c.json({ service: maskServiceSecrets(svc) })
  })

  // POST /services/from-template
  router.post("/from-template", requireScope("services:write"), async (c) => {
    const user = getUser(c)
    const body = await c.req.json().catch(() => null)
    const parsed = CreateServiceFromTemplateBody.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        400
      )
    }

    const agent = getSharedAgent()

    try {
      const row = await installFromTemplate({ agent, db }, user.id, {
        projectId: parsed.data.projectId,
        templateId: parsed.data.templateId,
        templateVersion: parsed.data.templateVersion,
        name: parsed.data.name,
        compose: parsed.data.compose,
      })
      return c.json({ service: maskServiceSecrets(row) }, 201)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "VALIDATION_ERROR") return c.json({ error: { code, message: (err as Error).message } }, 400)
      if (code === "NOT_FOUND") {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Project not found" } },
          404
        )
      }
      if (code === "FORBIDDEN") {
        return c.json(
          { error: { code: "FORBIDDEN", message: "Forbidden" } },
          403
        )
      }
      const message = err instanceof Error ? err.message : String(err)
      log.error({ err }, "installFromTemplate failed")
      return c.json({ error: { code: "INTERNAL", message } }, 500)
    }
  })

  // Explicit owner-only reveal, including PAT write scope. Audit before disclosure.
  router.post("/:id/secrets/reveal", requireScope("services:write"), ownerOnly, async (c) => {
    const user = getUser(c)
    const svc = await getServiceForOwner(db, c.req.param("id")!, user.id)
    if (!svc) return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404)
    const values = await revealServiceSecrets(svc)
    await db.insert(audit_log).values({
      user_id: user.id, action: "service.secrets.revealed", target_type: "service",
      target_id: svc.id, metadata: "{}", created_at: new Date(),
    })
    c.header("Cache-Control", "no-store")
    return c.json({ secrets: values })
  })

  // POST /services/:id/start
  router.post("/:id/start", requireScope("services:write"), ownerOnly, async (c) => {
    const user = getUser(c)
    const serviceId = c.req.param("id")!

    try {
      await startService({ agent: getSharedAgent(), db }, user.id, serviceId)
      return c.json({ ok: true })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "NOT_FOUND") {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Service not found" } },
          404
        )
      }
      if (code === "CONFLICT") {
        return c.json(
          { error: { code: "CONFLICT", message: (err as Error).message } },
          409
        )
      }
      log.error({ err, serviceId }, "start service failed")
      return c.json(
        { error: { code: "START_FAILED", message: "Start failed" } },
        500
      )
    }
  })

  // POST /services/:id/stop
  router.post("/:id/stop", requireScope("services:write"), ownerOnly, async (c) => {
    const user = getUser(c)
    const serviceId = c.req.param("id")!

    try {
      await stopService({ agent: getSharedAgent(), db }, user.id, serviceId)
      return c.json({ ok: true })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "NOT_FOUND") {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Service not found" } },
          404
        )
      }
      if (code === "CONFLICT") {
        return c.json(
          { error: { code: "CONFLICT", message: (err as Error).message } },
          409
        )
      }
      log.error({ err, serviceId }, "stop service failed")
      return c.json(
        { error: { code: "STOP_FAILED", message: "Stop failed" } },
        500
      )
    }
  })

  // DELETE /services/:id
  router.delete("/:id", requireScope("services:write"), ownerOnly, async (c) => {
    const user = getUser(c)
    const serviceId = c.req.param("id")!

    const svc = await getServiceForUser(db, serviceId, user.id)
    if (!svc) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Service not found" } },
        404
      )
    }

    const body = await c.req.json().catch(() => null)
    const confirm = body?.confirm
    if (confirm !== `delete ${svc.name}`) {
      return c.json(
        {
          error: {
            code: "CONFIRM_REQUIRED",
            message: `Send { "confirm": "delete ${svc.name}" } to confirm deletion`,
          },
        },
        400
      )
    }

    try {
      await deleteService({ agent: getSharedAgent(), db }, user.id, serviceId)
      return c.json({ ok: true })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "NOT_FOUND") {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Service not found" } },
          404
        )
      }
      log.error({ err, serviceId }, "delete service failed")
      return c.json(
        { error: { code: "DELETE_FAILED", message: "Delete failed" } },
        500
      )
    }
  })

  // GET /services/:id/logs
  router.get("/:id/logs", requireScope("services:read"), async (c) => {
    const user = getUser(c)
    const serviceId = c.req.param("id")!
    const containerIdx = Number(c.req.query("container") ?? 0)
    const tailRaw = Number(c.req.query("tail") ?? 200)
    const tail = Number.isFinite(tailRaw)
      ? Math.max(1, Math.min(Math.floor(tailRaw), 1_000))
      : 200

    const svc = await getServiceForUser(db, serviceId, user.id)
    if (!svc) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Service not found" } },
        404
      )
    }

    const ids = svc.container_ids ?? []
    const idx = Number.isFinite(containerIdx) ? Math.max(0, containerIdx) : 0
    const containerId = ids[idx]
    if (!containerId) {
      return c.json({ lines: [], containerFound: false })
    }

    try {
      const agent = getSharedAgent()
      const lines: Array<{
        t: number
        line: string
        stream?: "stdout" | "stderr"
      }> = []
      for await (const entry of agent.containerLogs({
        containerId,
        follow: false,
        sinceUnix: 0,
        tail,
      })) {
        const item: { t: number; line: string; stream?: "stdout" | "stderr" } =
          {
            t: Date.parse(entry.timestamp) || Date.now(),
            line: entry.line,
          }
        if (entry.stream === "stdout" || entry.stream === "stderr")
          item.stream = entry.stream
        lines.push(item)
      }
      return c.json({ lines, containerFound: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "LOGS_ERROR", message } }, 500)
    }
  })

  return router
}

export function servicesRouterFactory() {
  const db = createDb(env.DATABASE_URL)
  return createServicesRouter(db)
}
