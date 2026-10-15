// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from "hono"
import { eq } from "drizzle-orm"
import type { Db } from "@ploydok/db"
import { projects } from "@ploydok/db"
import { hasFeature, hasQuota } from "@ploydok/db/queries"
import type { FeatureKey, QuotaKey } from "@ploydok/shared"

/**
 * Resolve a route identifier (project UUID or slug) to `projects.id`.
 * `org_subscriptions.org_id` is the UUID — never a slug.
 */
export async function resolveOrganizationId(
  db: Db,
  identifier: string
): Promise<string | null> {
  const byId = await db.query.projects.findFirst({
    where: eq(projects.id, identifier),
  })
  if (byId) {
    return byId.id
  }

  const bySlug = await db.query.projects.findFirst({
    where: eq(projects.slug, identifier),
  })
  return bySlug?.id ?? null
}

/**
 * Middleware that checks if an organization has a feature enabled.
 * Reads `slug`, `orgSlug`, or `orgId` from the route and resolves to
 * `projects.id` before consulting the subscription.
 *
 * Returns 404 if the organization does not exist, 403 if the feature
 * is not included in the org's plan.
 */
export function requireFeature(db: Db, feature: FeatureKey): MiddlewareHandler {
  return async (c, next) => {
    const orgIdentifier =
      c.req.param("slug") || c.req.param("orgId") || c.req.param("orgSlug")

    if (!orgIdentifier) {
      return c.json(
        { error: "Missing organization identifier" },
        { status: 400 }
      )
    }

    const orgId = await resolveOrganizationId(db, orgIdentifier)
    if (!orgId) {
      return c.json({ error: "Organization not found" }, { status: 404 })
    }

    const hasAccess = await hasFeature(db, orgId, feature)

    if (!hasAccess) {
      return c.json(
        {
          error: `Feature ${feature} is not available in your plan`,
          feature,
        },
        { status: 403 }
      )
    }

    await next()
  }
}

/**
 * Check if an organization is within quota for a specific limit.
 *
 * @param db Database instance
 * @param orgId Organization ID
 * @param quota Quota key to check
 * @param currentUsage Current usage count (caller's responsibility to count)
 * @returns true if organization is within quota, false otherwise
 */
export async function checkQuota(
  db: Db,
  orgId: string,
  quota: QuotaKey,
  currentUsage: number
): Promise<boolean> {
  return hasQuota(db, orgId, quota, currentUsage)
}
