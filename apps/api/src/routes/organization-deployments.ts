// SPDX-License-Identifier: AGPL-3.0-only
//
// Workspace-wide application deployment history.

import { Hono } from "hono"
import type { Db } from "@ploydok/db"
import {
  getMembership,
  listOrganizationDeploymentActivity,
  listOrganizationDeployments,
} from "@ploydok/db/queries"
import {
  OrganizationDeploymentActivityQuerySchema,
  OrganizationDeploymentActivityResponseSchema,
  OrganizationDeploymentsQuerySchema,
  OrganizationDeploymentsResponseSchema,
} from "@ploydok/shared"
import type { OrganizationDeploymentActivityBucket } from "@ploydok/shared"
import type { AuthUser } from "../auth/middleware"
import { requireScope } from "../auth/require-scope"
import { getOrganizationBySlugForUser } from "../services/organizations"

function getUser(c: { get: (key: string) => unknown }): AuthUser | undefined {
  return c.get("user") as AuthUser | undefined
}

function serializeBuild(
  row: Awaited<
    ReturnType<typeof listOrganizationDeployments>
  >["deployments"][number]
) {
  const build = row.build
  return {
    id: build.id,
    appId: build.app_id,
    status: build.status,
    buildMethod: build.build_method,
    // Keep optional nullable DB fields omitted so the shared response schema
    // remains truthful for consumers of this aggregate endpoint.
    imageTag: build.image_tag ?? undefined,
    containerId: build.container_id ?? undefined,
    runtimeRef: build.runtime_ref,
    commitSha: build.commit_sha ?? undefined,
    commitMessage: build.commit_message,
    errorMessage: build.error_message,
    postDeployError: build.post_deploy_error,
    requestedByUserId: build.requested_by_user_id,
    source: build.source,
    startedAt: build.started_at?.getTime(),
    finishedAt: build.finished_at?.getTime(),
    createdAt: build.created_at.getTime(),
    app: row.app,
  }
}

const DAY_MS = 86_400_000

/**
 * One zero-filled bucket per UTC day, oldest first, ending today. Warning
 * builds count as succeeded; pending, running and cancelled builds as other.
 */
export function buildActivityBuckets(
  rows: ReadonlyArray<{ day: string; status: string; total: number }>,
  days: number,
  now: Date
): OrganizationDeploymentActivityBucket[] {
  const todayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )
  const buckets = new Map<string, OrganizationDeploymentActivityBucket>()
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(todayStart - offset * DAY_MS)
      .toISOString()
      .slice(0, 10)
    buckets.set(date, { date, succeeded: 0, failed: 0, other: 0 })
  }
  for (const row of rows) {
    const bucket = buckets.get(row.day)
    if (!bucket) continue
    if (row.status === "succeeded" || row.status === "succeeded_with_warning") {
      bucket.succeeded += row.total
    } else if (row.status === "failed") {
      bucket.failed += row.total
    } else {
      bucket.other += row.total
    }
  }
  return [...buckets.values()]
}

export function createOrganizationDeploymentsRouter(db: Db): Hono {
  const router = new Hono()
  const appsRead = requireScope("apps:read")

  router.get("/:orgSlug/deployments", appsRead, async (c) => {
    const parsed = OrganizationDeploymentsQuerySchema.safeParse({
      page: c.req.query("page"),
      pageSize: c.req.query("pageSize"),
      appId: c.req.query("appId"),
      status: c.req.query("status"),
      source: c.req.query("source"),
      q: c.req.query("q"),
      from: c.req.query("from"),
      to: c.req.query("to"),
    })
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid deployment filters",
          },
        },
        400
      )
    }

    const filters = parsed.data
    const from = filters.from ? new Date(filters.from) : undefined
    const to = filters.to ? new Date(filters.to) : undefined
    if (from && to && from > to) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "The from filter must be before the to filter",
          },
        },
        400
      )
    }

    const user = getUser(c)
    if (!user) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        },
        401
      )
    }

    const organization = await getOrganizationBySlugForUser(
      db,
      user.id,
      c.req.param("orgSlug")!
    )
    if (!organization) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Organization not found" } },
        404
      )
    }

    const result = await listOrganizationDeployments(db, organization.id, {
      page: filters.page,
      pageSize: filters.pageSize,
      ...(filters.appId !== undefined && { appId: filters.appId }),
      ...(filters.status !== undefined && { status: filters.status }),
      ...(filters.source !== undefined && { source: filters.source }),
      ...(filters.q !== undefined && { q: filters.q }),
      ...(from !== undefined && { from }),
      ...(to !== undefined && { to }),
    })
    const totalPages = Math.ceil(result.total / filters.pageSize)
    const membership = await getMembership(db, organization.id, user.id)
    const canManage = membership?.role === "owner"

    const response = {
      deployments: result.deployments.map(serializeBuild),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: result.total,
        totalPages,
        hasNext: filters.page < totalPages,
      },
      summary: result.summary,
      canManage,
    }

    return c.json(OrganizationDeploymentsResponseSchema.parse(response))
  })

  router.get("/:orgSlug/deployments/activity", appsRead, async (c) => {
    const parsed = OrganizationDeploymentActivityQuerySchema.safeParse({
      days: c.req.query("days"),
    })
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "days must be 7, 30 or 90",
          },
        },
        400
      )
    }

    const user = getUser(c)
    if (!user) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        },
        401
      )
    }

    const organization = await getOrganizationBySlugForUser(
      db,
      user.id,
      c.req.param("orgSlug")!
    )
    if (!organization) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Organization not found" } },
        404
      )
    }

    const { days } = parsed.data
    const now = new Date()
    const since = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        (days - 1) * DAY_MS
    )
    const rows = await listOrganizationDeploymentActivity(
      db,
      organization.id,
      since
    )

    return c.json(
      OrganizationDeploymentActivityResponseSchema.parse({
        days,
        buckets: buildActivityBuckets(rows, days, now),
      })
    )
  })

  return router
}
