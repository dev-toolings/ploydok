// SPDX-License-Identifier: AGPL-3.0-only
//
// Workspace-wide build history. The project_id predicate is deliberately on
// the app join: a build can never escape the workspace that owns its app.

import { and, count, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm"
import type { Db } from "../client"
import { apps, builds } from "../schema"

export type OrganizationDeploymentStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "succeeded_with_warning"
  | "failed"
  | "cancelled"

export interface ListOrganizationDeploymentsOptions {
  page: number
  pageSize: number
  appId?: string | undefined
  status?: OrganizationDeploymentStatus | undefined
  source?: (typeof builds.$inferSelect)["source"] | undefined
  q?: string | undefined
  from?: Date | undefined
  to?: Date | undefined
}

const statuses = [
  "pending",
  "running",
  "succeeded",
  "succeeded_with_warning",
  "failed",
  "cancelled",
] as const

export type OrganizationDeploymentRow = {
  build: typeof builds.$inferSelect
  app: Pick<typeof apps.$inferSelect, "id" | "name" | "slug">
}

export interface OrganizationDeploymentSummary {
  total: number
  pending: number
  running: number
  succeeded: number
  succeededWithWarning: number
  failed: number
  cancelled: number
}

function filtersFor(
  organizationId: string,
  options: Omit<ListOrganizationDeploymentsOptions, "page" | "pageSize">
) {
  const filters = [eq(apps.project_id, organizationId)]

  if (options.appId) filters.push(eq(builds.app_id, options.appId))
  if (options.status) filters.push(eq(builds.status, options.status))
  if (options.source) filters.push(eq(builds.source, options.source))
  if (options.from) filters.push(gte(builds.created_at, options.from))
  if (options.to) filters.push(lte(builds.created_at, options.to))
  if (options.q) {
    const pattern = `%${options.q}%`
    filters.push(
      or(
        ilike(apps.name, pattern),
        ilike(builds.commit_sha, pattern),
        ilike(builds.commit_message, pattern)
      )!
    )
  }

  return and(...filters)
}

/**
 * Lists builds owned by a single workspace, independently of who owns the
 * request. The route must resolve membership before calling this query.
 */
export async function listOrganizationDeployments(
  db: Db,
  organizationId: string,
  options: ListOrganizationDeploymentsOptions
): Promise<{
  deployments: OrganizationDeploymentRow[]
  total: number
  summary: OrganizationDeploymentSummary
}> {
  const where = filtersFor(organizationId, options)
  const offset = (options.page - 1) * options.pageSize

  const [deployments, totalRows, summaryRows] = await Promise.all([
    db
      .select({
        build: builds,
        app: { id: apps.id, name: apps.name, slug: apps.slug },
      })
      .from(builds)
      .innerJoin(apps, eq(builds.app_id, apps.id))
      .where(where)
      .orderBy(desc(builds.created_at), desc(builds.id))
      .limit(options.pageSize)
      .offset(offset),
    db
      .select({ total: count() })
      .from(builds)
      .innerJoin(apps, eq(builds.app_id, apps.id))
      .where(where),
    db
      .select({
        status: builds.status,
        total: sql<number>`count(*)::int`,
      })
      .from(builds)
      .innerJoin(apps, eq(builds.app_id, apps.id))
      .where(where)
      .groupBy(builds.status),
  ])

  const summary: OrganizationDeploymentSummary = {
    total: Number(totalRows[0]?.total ?? 0),
    pending: 0,
    running: 0,
    succeeded: 0,
    succeededWithWarning: 0,
    failed: 0,
    cancelled: 0,
  }

  for (const row of summaryRows) {
    const value = Number(row.total)
    switch (row.status) {
      case "pending":
        summary.pending = value
        break
      case "running":
        summary.running = value
        break
      case "succeeded":
        summary.succeeded = value
        break
      case "succeeded_with_warning":
        summary.succeededWithWarning = value
        break
      case "failed":
        summary.failed = value
        break
      case "cancelled":
        summary.cancelled = value
        break
      default:
        break
    }
  }

  return { deployments, total: summary.total, summary }
}

export const organizationDeploymentStatuses = statuses

export interface OrganizationDeploymentActivityRow {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string
  status: OrganizationDeploymentStatus
  total: number
}

/**
 * Counts a workspace's builds per UTC day and status since `since`. Days
 * without builds are absent; the caller fills the gaps.
 */
export async function listOrganizationDeploymentActivity(
  db: Db,
  organizationId: string,
  since: Date
): Promise<OrganizationDeploymentActivityRow[]> {
  const day = sql<string>`to_char(${builds.created_at} at time zone 'UTC', 'YYYY-MM-DD')`
  const rows = await db
    .select({
      day,
      status: builds.status,
      total: sql<number>`count(*)::int`,
    })
    .from(builds)
    .innerJoin(apps, eq(builds.app_id, apps.id))
    .where(
      and(eq(apps.project_id, organizationId), gte(builds.created_at, since))
    )
    .groupBy(day, builds.status)

  return rows.map((row) => ({
    day: row.day,
    status: row.status as OrganizationDeploymentStatus,
    total: Number(row.total),
  }))
}
