// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import { nanoid } from "nanoid"
import { createDb } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import {
  CreateAppVolumeSchema,
  UpdateAppVolumeSchema,
} from "@ploydok/shared"
import {
  deleteAppVolume,
  getAppForUser,
  getAppVolume,
  insertAppVolume,
  listAppVolumes,
  updateAppVolume,
} from "@ploydok/db/queries"
import { env } from "../env"
import type { AuthUser } from "../auth/middleware"
import { requireSecondFactor } from "../auth/middleware"
import { requireScope } from "../auth/require-scope"
import {
  purgeAppVolumeHostPath,
  serializeAppVolume,
} from "../services/app-volumes"

function getUser(c: { get: (key: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /duplicate key value/i.test(err.message)
}

function volumeConflictMessage(err: Error): string {
  if (err.message.includes("app_volumes_app_name_idx")) {
    return "volume name already exists for this app"
  }
  if (err.message.includes("app_volumes_app_mount_path_idx")) {
    return "mount path already exists for this app"
  }
  return "app volume conflicts with an existing volume"
}

export function appHasLiveRuntime(app: {
  status: string | null
  container_id: string | null
  swarm_service_name?: string | null
}): boolean {
  return (
    Boolean(app.container_id || app.swarm_service_name) &&
    ["pending", "building", "running", "serving", "restarting"].includes(
      app.status ?? ""
    )
  )
}

export function createAppsVolumesRouter(db: Db): Hono {
  const router = new Hono()

  const sf = requireSecondFactor(db)
  const appsRead = requireScope("apps:read")
  const appsWrite = requireScope("apps:write")

  router.get("/:id/volumes", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const rows = await listAppVolumes(db, appId)
    return c.json({ volumes: rows.map(serializeAppVolume) })
  })

  router.post("/:id/volumes", appsWrite, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    let body: ReturnType<typeof CreateAppVolumeSchema.parse>
    try {
      body = CreateAppVolumeSchema.parse(await c.req.json())
    } catch (err) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: String(err) } },
        400
      )
    }

    try {
      const row = await insertAppVolume(db, {
        id: nanoid(),
        app_id: appId,
        name: body.name,
        mount_path: body.mountPath,
        size_limit_bytes: body.sizeLimitBytes ?? null,
      })

      return c.json({ volume: serializeAppVolume(row) }, 201)
    } catch (err) {
      if (isUniqueViolation(err) && err instanceof Error) {
        return c.json(
          {
            error: {
              code: "CONFLICT",
              message: volumeConflictMessage(err),
            },
          },
          409
        )
      }
      throw err
    }
  })

  router.patch("/:id/volumes/:volumeId", appsWrite, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!
    const volumeId = c.req.param("volumeId")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const existing = await getAppVolume(db, appId, volumeId)
    if (!existing) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Volume not found" } },
        404
      )
    }

    let body: ReturnType<typeof UpdateAppVolumeSchema.parse>
    try {
      body = UpdateAppVolumeSchema.parse(await c.req.json())
    } catch (err) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: String(err) } },
        400
      )
    }

    try {
      const row = await updateAppVolume(db, appId, volumeId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.mountPath !== undefined ? { mount_path: body.mountPath } : {}),
        ...(body.sizeLimitBytes !== undefined
          ? { size_limit_bytes: body.sizeLimitBytes }
          : {}),
      })

      return c.json({ volume: serializeAppVolume(row!) })
    } catch (err) {
      if (isUniqueViolation(err) && err instanceof Error) {
        return c.json(
          {
            error: {
              code: "CONFLICT",
              message: volumeConflictMessage(err),
            },
          },
          409
        )
      }
      throw err
    }
  })

  router.delete("/:id/volumes/:volumeId", appsWrite, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!
    const volumeId = c.req.param("volumeId")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const existing = await getAppVolume(db, appId, volumeId)
    if (!existing) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Volume not found" } },
        404
      )
    }

    if (appHasLiveRuntime(app)) {
      return c.json(
        {
          error: {
            code: "INVALID_STATE",
            message:
              "Stop the app before deleting a persistent volume from disk",
          },
        },
        409
      )
    }

    await deleteAppVolume(db, appId, volumeId)
    await purgeAppVolumeHostPath(appId, volumeId)

    return c.json({ ok: true })
  })

  return router
}

const prodDb = createDb(env.DATABASE_URL)
export const appsVolumesRouter = createAppsVolumesRouter(prodDb)
