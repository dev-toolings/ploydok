// SPDX-License-Identifier: AGPL-3.0-only
//
// App CRUD queries — thin wrappers over Drizzle to keep routes clean.
//
import { and, desc, eq, isNotNull } from "drizzle-orm"
import { apps, audit_log, builds, projects, memberships } from "../schema"
import type { Db } from "../client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppRow = typeof apps.$inferSelect
export type BuildRow = typeof builds.$inferSelect

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns the app row if the given user has access (any role) via membership.
 */
export async function getAppForUser(
  db: Db,
  appId: string,
  userId: string
): Promise<AppRow | null> {
  const rows = await db
    .select({ app: apps })
    .from(apps)
    .innerJoin(projects, eq(apps.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        isNotNull(memberships.accepted_at)
      )
    )
    .where(eq(apps.id, appId))
    .limit(1)

  return rows[0]?.app ?? null
}

/**
 * Returns the app row if the given user is an owner (role='owner') via membership.
 */
export async function getAppForOwner(
  db: Db,
  appId: string,
  userId: string
): Promise<AppRow | null> {
  const rows = await db
    .select({ app: apps })
    .from(apps)
    .innerJoin(projects, eq(apps.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        eq(memberships.role, "owner"),
        isNotNull(memberships.accepted_at)
      )
    )
    .where(eq(apps.id, appId))
    .limit(1)

  return rows[0]?.app ?? null
}

export async function getAppByRepoAndOwner(
  db: Db,
  repoFullName: string
): Promise<AppRow | null> {
  const rows = await db
    .select({ app: apps })
    .from(apps)
    .where(eq(apps.repo_full_name, repoFullName))
    .limit(1)

  return rows[0]?.app ?? null
}

/**
 * Returns all apps belonging to projects where user has access (any role).
 */
export async function listAppsForUser(
  db: Db,
  userId: string,
  projectId?: string
): Promise<
  {
    id: string
    project_id: string
    name: string
    slug: string
    status: string | null
    git_provider: string | null
    repo_full_name: string | null
    image_ref: string | null
    branch: string | null
    build_method: string | null
    framework_preset: string | null
    framework_detection: string | null
    domain: string | null
    container_id: string | null
    runtime_mode: "docker" | "swarm"
    swarm_service_name: string | null
    icon_url: string | null
    quick_links: string | null
    track_latest: boolean
    last_image_digest: string | null
    pending_image_digest: string | null
    created_at: Date | null
    updated_at: Date | null
  }[]
> {
  const conditions = projectId ? [eq(apps.project_id, projectId)] : []

  return db
    .select({
      id: apps.id,
      project_id: apps.project_id,
      name: apps.name,
      slug: apps.slug,
      status: apps.status,
      git_provider: apps.git_provider,
      repo_full_name: apps.repo_full_name,
      image_ref: apps.image_ref,
      branch: apps.branch,
      build_method: apps.build_method,
      framework_preset: apps.framework_preset,
      framework_detection: apps.framework_detection,
      domain: apps.domain,
      container_id: apps.container_id,
      runtime_mode: apps.runtime_mode,
      swarm_service_name: apps.swarm_service_name,
      icon_url: apps.icon_url,
      quick_links: apps.quick_links,
      track_latest: apps.track_latest,
      last_image_digest: apps.last_image_digest,
      pending_image_digest: apps.pending_image_digest,
      created_at: apps.created_at,
      updated_at: apps.updated_at,
    })
    .from(apps)
    .innerJoin(projects, eq(apps.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        isNotNull(memberships.accepted_at)
      )
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
}

/**
 * Returns the last `limit` builds for an app, ordered newest first.
 */
export async function listBuildsForApp(
  db: Db,
  appId: string,
  limit = 10
): Promise<BuildRow[]> {
  return db
    .select()
    .from(builds)
    .where(eq(builds.app_id, appId))
    .orderBy(desc(builds.created_at))
    .limit(limit)
}

// ---------------------------------------------------------------------------
// Activity (derived from builds)
// ---------------------------------------------------------------------------

export type ActivityEventType =
  | "build.started"
  | "build.succeeded"
  | "build.failed"
  | "build.cancelled"

export interface ActivityEvent {
  id: string
  type: ActivityEventType
  /** Unix timestamp in milliseconds */
  timestamp: number
  buildId: string
  data: {
    message?: string | undefined
    commitSha?: string | undefined
    commitMessage?: string | undefined
    errorMessage?: string | undefined
  }
}

/**
 * Derives an activity timeline for an app from its build rows. Each terminal
 * build produces two events (started + outcome); pending/running builds emit
 * only the started event.
 *
 * Returns events sorted newest first, capped to `limit`.
 */
export function deriveActivityFromBuilds(
  rows: BuildRow[],
  limit: number
): ActivityEvent[] {
  const events: ActivityEvent[] = []

  for (const row of rows) {
    const startTs =
      (row.started_at instanceof Date ? row.started_at.getTime() : null) ??
      (row.created_at instanceof Date ? row.created_at.getTime() : null)

    const commitSha = row.commit_sha ?? undefined
    const commitMessage = row.commit_message ?? undefined

    if (startTs !== null) {
      events.push({
        id: `${row.id}.started`,
        type: "build.started",
        timestamp: startTs,
        buildId: row.id,
        data: {
          message: commitMessage ?? undefined,
          commitSha,
          commitMessage,
        },
      })
    }

    if (
      (row.status === "succeeded" ||
        row.status === "failed" ||
        row.status === "cancelled") &&
      row.finished_at instanceof Date
    ) {
      const type: ActivityEventType =
        row.status === "succeeded"
          ? "build.succeeded"
          : row.status === "failed"
            ? "build.failed"
            : "build.cancelled"

      events.push({
        id: `${row.id}.${row.status}`,
        type,
        timestamp: row.finished_at.getTime(),
        buildId: row.id,
        data: {
          message:
            row.status === "failed" && row.error_message
              ? row.error_message
              : (commitMessage ?? undefined),
          commitSha,
          commitMessage,
          errorMessage: row.error_message ?? undefined,
        },
      })
    }
  }

  events.sort((a, b) => b.timestamp - a.timestamp)
  return events.slice(0, limit)
}

/**
 * Returns recent activity for an app, derived from its builds table.
 * To get N events we read up to N builds (each produces 1-2 events).
 */
export async function getAppActivity(
  db: Db,
  appId: string,
  limit = 20
): Promise<ActivityEvent[]> {
  const rows = await listBuildsForApp(db, appId, limit)
  return deriveActivityFromBuilds(rows, limit)
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type InsertAppInput = typeof apps.$inferInsert

/** Inserts a new app row and returns the persisted row. */
export async function insertApp(
  db: Db,
  values: InsertAppInput
): Promise<AppRow> {
  await db.insert(apps).values(values)
  const rows = await db
    .select()
    .from(apps)
    .where(eq(apps.id, values.id!))
    .limit(1)
  return rows[0]!
}

/** Updates an app row by id and returns the updated row. */
export async function updateApp(
  db: Db,
  appId: string,
  patch: Record<string, unknown>
): Promise<AppRow> {
  await db.update(apps).set(patch).where(eq(apps.id, appId))
  const rows = await db.select().from(apps).where(eq(apps.id, appId)).limit(1)
  return rows[0]!
}

/** Sets app status to 'deleting'. */
export async function markAppDeleting(db: Db, appId: string): Promise<void> {
  await db
    .update(apps)
    .set({ status: "deleting", updated_at: new Date() })
    .where(eq(apps.id, appId))
}

/** Finds the first slug candidate that is not already in use within the project. */
export async function uniqueSlug(
  db: Db,
  projectId: string,
  base: string,
  excludeAppId?: string
): Promise<string> {
  let candidate = base || "app"
  let attempt = 1
  for (;;) {
    const existing = await db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.project_id, projectId), eq(apps.slug, candidate)))
      .limit(1)

    const conflict = existing.find((r) => r.id !== excludeAppId)
    if (!conflict) return candidate
    attempt++
    candidate = `${base}-${attempt}`
  }
}

// ---------------------------------------------------------------------------
// Build helpers used by lifecycle routes
// ---------------------------------------------------------------------------

export type BuildLogRow = {
  id: string
  app_id: string
  log_path: string | null
  log_archive: string | null
  log_purged_at: Date | null
}

/** Returns the build row (id + app_id + log_path + archive metadata) for a given build/app pair. */
export async function getBuildLogPath(
  db: Db,
  buildId: string,
  appId: string
): Promise<BuildLogRow | null> {
  const rows = await db
    .select({
      id: builds.id,
      app_id: builds.app_id,
      log_path: builds.log_path,
      log_archive: builds.log_archive,
      log_purged_at: builds.log_purged_at,
    })
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.app_id, appId)))
    .limit(1)
  return rows[0] ?? null
}

export type BuildStatusRow = { id: string; app_id: string; status: string }

/** Returns id + app_id + status for a build belonging to a specific app. */
export async function getBuildForApp(
  db: Db,
  buildId: string,
  appId: string
): Promise<BuildStatusRow | null> {
  const rows = await db
    .select({ id: builds.id, app_id: builds.app_id, status: builds.status })
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.app_id, appId)))
    .limit(1)
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  user_id: string
  action: string
  target_type: string
  target_id: string
  metadata?: string
  created_at?: Date
}

/**
 * Inserts an audit log entry. Swallows errors so callers can use fire-and-forget.
 * Returns true on success, false on failure.
 */
export async function insertAuditLog(
  db: Db,
  entry: AuditLogEntry
): Promise<boolean> {
  try {
    await db.insert(audit_log).values({
      user_id: entry.user_id,
      action: entry.action,
      target_type: entry.target_type,
      target_id: entry.target_id,
      metadata: entry.metadata ?? "{}",
      created_at: entry.created_at ?? new Date(),
    })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Webhook secret rotation
// ---------------------------------------------------------------------------

/** Rotates the per-app webhook secret: current → old, new → current. */
export async function rotateAppWebhookSecret(
  db: Db,
  appId: string,
  currentSecretBlob: Buffer | null,
  newSecretBlob: Buffer,
  now: Date
): Promise<void> {
  await db
    .update(apps)
    .set({
      webhook_secret: newSecretBlob,
      webhook_secret_old: currentSecretBlob,
      webhook_secret_old_expires_at: new Date(
        now.getTime() + 24 * 60 * 60 * 1000
      ),
      updated_at: now,
    })
    .where(eq(apps.id, appId))
}
