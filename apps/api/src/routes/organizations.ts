// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import type { Db } from "@ploydok/db"
import {
  CreateOrganizationBodySchema,
  UpdateOrganizationBodySchema,
} from "@ploydok/shared"
import type { AuthUser } from "../auth/middleware"
import { requireRole } from "../auth/require-role"
import {
  createOrganizationForUser,
  deleteOrganizationForUser,
  getDefaultOrganizationForUser,
  getOrganizationBySlugForUser,
  listOrganizationsForUser,
  renameOrganizationForUser,
} from "../services/organizations"

function getUser(c: { get: (key: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

export function createOrganizationsRouter(db: Db): Hono {
  const router = new Hono()

  router.post("/", async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = CreateOrganizationBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace payload",
          },
        },
        400
      )
    }

    const user = getUser(c)
    const organization = await createOrganizationForUser(
      db,
      user.id,
      parsed.data.name,
      user.display_name
    )
    return c.json({ organization }, 201)
  })

  router.get("/", async (c) => {
    const user = getUser(c)
    const organizations = await listOrganizationsForUser(
      db,
      user.id,
      user.display_name
    )
    return c.json({ organizations })
  })

  router.get("/default", async (c) => {
    const user = getUser(c)
    const organization = await getDefaultOrganizationForUser(
      db,
      user.id,
      user.display_name
    )
    return c.json({ organization })
  })

  router.get("/:slug", async (c) => {
    const user = getUser(c)
    const organization = await getOrganizationBySlugForUser(
      db,
      user.id,
      c.req.param("slug")
    )
    if (!organization) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Organization not found" } },
        404
      )
    }
    return c.json({ organization })
  })

  router.patch("/:slug", requireRole(db, ["owner"]), async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = UpdateOrganizationBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace payload",
          },
        },
        400
      )
    }

    const result = await renameOrganizationForUser(
      db,
      c.req.param("slug")!,
      parsed.data.name,
      parsed.data.reslug
    )
    if (!result.ok) {
      if (result.reason === "not_found") {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Organization not found" } },
          404
        )
      }
      return c.json(
        {
          error: {
            code: "SLUG_CONFLICT",
            message: "Could not allocate a unique workspace URL",
          },
        },
        409
      )
    }
    return c.json({
      organization: result.organization,
      slug_changed: result.slug_changed,
      previous_slug: result.previous_slug,
      slug_frozen_reason: result.slug_frozen_reason,
    })
  })

  router.delete("/:slug", requireRole(db, ["owner"]), async (c) => {
    const user = getUser(c)
    const result = await deleteOrganizationForUser(
      db,
      user.id,
      c.req.param("slug")!
    )
    if (!result.ok) {
      if (result.reason === "not_empty") {
        return c.json(
          {
            error: {
              code: "ORGANIZATION_NOT_EMPTY",
              message:
                "Delete all apps, services and databases before deleting the organization",
            },
          },
          409
        )
      }
      if (result.reason === "not_found") {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Organization not found" } },
          404
        )
      }
      return c.json(
        { error: { code: "FORBIDDEN", message: "Owner role required" } },
        403
      )
    }
    return c.body(null, 204)
  })

  return router
}
