// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNotNull } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  apps,
  databases,
  eventWebhooks,
  memberships,
  org_subscriptions,
  projects,
  scheduled_jobs,
  services,
  sso_configs,
} from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { setOrgSubscription } from "@ploydok/db/queries"

/**
 * Ensure the user has an owner-level membership on the given project.
 * Idempotent via ON CONFLICT DO NOTHING on (org_id, user_id).
 * Swallows all errors (FK violations, races, etc.) so that read paths
 * like GET /organizations never 500 because of a backfill failure.
 */
async function ensureOwnerMembership(
  db: Pick<Db, "insert">,
  orgId: string,
  userId: string,
  invitedAt: Date
): Promise<void> {
  try {
    await db
      .insert(memberships)
      .values({
        id: nanoid(),
        org_id: orgId,
        user_id: userId,
        role: "owner",
        invited_by: null,
        invited_at: invitedAt,
        accepted_at: invitedAt,
      })
      .onConflictDoNothing({
        target: [memberships.org_id, memberships.user_id],
      })
  } catch {
    // Best-effort backfill. If insert fails (e.g. user FK missing, race with
    // concurrent delete, odd constraint state), log at higher layer and skip.
  }
}

export interface OrganizationSummary {
  id: string
  name: string
  slug: string
  is_default: boolean
  created_at: string
}

function slugifyOrganizationName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function buildDefaultOrganizationName(
  displayName: string | null | undefined
): string {
  const normalized = displayName?.trim()
  return normalized && normalized.length > 0 ? normalized : "My Organization"
}

type DbOrTx = Pick<Db, "select">

async function uniqueOrganizationSlug(
  db: DbOrTx,
  baseName: string
): Promise<string> {
  const base = slugifyOrganizationName(baseName) || "workspace"
  let candidate = base
  let attempt = 1
  for (;;) {
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, candidate))
      .limit(1)

    if (!existing[0]) return candidate
    attempt += 1
    candidate = `${base}-${attempt}`
  }
}

function toSummary(row: typeof projects.$inferSelect): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    is_default: row.is_default,
    created_at: row.created_at.toISOString(),
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  )
}

type OrgSubscriptionDb = Pick<Db, "insert" | "update" | "query">

// Skip existing rows so a retry cannot downgrade a paid workspace.
export async function ensureFreeOrgSubscription(
  db: OrgSubscriptionDb,
  orgId: string
): Promise<void> {
  try {
    const existing = await db.query.org_subscriptions.findFirst({
      where: eq(org_subscriptions.org_id, orgId),
    })
    if (existing) return
    await setOrgSubscription(db, orgId, "free", "active")
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
  }
}

export async function ensureDefaultOrganizationForUser(
  db: Db,
  userId: string,
  displayName?: string | null
): Promise<typeof projects.$inferSelect> {
  try {
    return await db.transaction(async (tx) => {
      const existingDefault = await tx
        .select()
        .from(projects)
        .where(
          and(eq(projects.owner_id, userId), eq(projects.is_default, true))
        )
        .orderBy(asc(projects.created_at), asc(projects.id))
        .limit(1)

      if (existingDefault[0]) {
        await ensureOwnerMembership(
          tx,
          existingDefault[0].id,
          userId,
          existingDefault[0].created_at
        )
        return existingDefault[0]
      }

      const oldest = await tx
        .select()
        .from(projects)
        .where(eq(projects.owner_id, userId))
        .orderBy(asc(projects.created_at), asc(projects.id))
        .limit(1)

      if (oldest[0]) {
        await tx
          .update(projects)
          .set({ is_default: true })
          .where(eq(projects.id, oldest[0].id))
        await ensureOwnerMembership(
          tx,
          oldest[0].id,
          userId,
          oldest[0].created_at
        )
        return { ...oldest[0], is_default: true }
      }

      const now = new Date()
      const name = buildDefaultOrganizationName(displayName)
      const [inserted] = await tx
        .insert(projects)
        .values({
          id: nanoid(),
          owner_id: userId,
          name,
          slug: await uniqueOrganizationSlug(tx, name),
          is_default: true,
          created_at: now,
        })
        .returning()
      if (!inserted) throw new Error("failed to insert default organization")
      await ensureOwnerMembership(tx, inserted.id, userId, now)
      await ensureFreeOrgSubscription(tx, inserted.id)
      return inserted
    })
  } catch (err) {
    // Concurrent caller won the race and created the default first.
    // Re-read and return theirs.
    if (!isUniqueViolation(err)) throw err
    const fallback = await db
      .select()
      .from(projects)
      .where(and(eq(projects.owner_id, userId), eq(projects.is_default, true)))
      .orderBy(asc(projects.created_at), asc(projects.id))
      .limit(1)
    if (fallback[0]) return fallback[0]
    throw err
  }
}

export async function listOrganizationsForUser(
  db: Db,
  userId: string,
  displayName?: string | null
): Promise<OrganizationSummary[]> {
  await ensureDefaultOrganizationForUser(db, userId, displayName).catch(
    () => {}
  )
  await backfillOwnerMemberships(db, userId)

  try {
    const rows = await db
      .select()
      .from(projects)
      .innerJoin(
        memberships,
        and(
          eq(memberships.org_id, projects.id),
          eq(memberships.user_id, userId),
          isNotNull(memberships.accepted_at)
        )
      )
      .orderBy(asc(projects.created_at), asc(projects.id))

    if (rows.length > 0) return rows.map((r) => toSummary(r.projects))
  } catch {
    // memberships table missing (migration not yet applied) or transient DB
    // issue — fall through to legacy owner_id path below.
  }

  // Legacy fallback : shows the user their projects via owner_id when the
  // memberships join fails or returns empty. Keeps the UI usable before/during
  // the RBAC v1 migration rollout.
  const legacyRows = await db
    .select()
    .from(projects)
    .where(eq(projects.owner_id, userId))
    .orderBy(asc(projects.created_at), asc(projects.id))
  return legacyRows.map((r) => toSummary(r))
}

/**
 * Safety net : for any project where the user is still the `owner_id` but
 * has no membership row (legacy projects created before the memberships
 * seed migration, or projects created between seed and a later fix),
 * insert the missing owner membership. Idempotent.
 */
async function backfillOwnerMemberships(db: Db, userId: string): Promise<void> {
  const ownedProjects = await db
    .select({ id: projects.id, created_at: projects.created_at })
    .from(projects)
    .where(eq(projects.owner_id, userId))

  if (ownedProjects.length === 0) return
  const now = new Date()
  for (const p of ownedProjects) {
    await ensureOwnerMembership(db, p.id, userId, p.created_at ?? now)
  }
}

export async function createOrganizationForUser(
  db: Db,
  userId: string,
  name: string,
  displayName?: string | null
): Promise<OrganizationSummary> {
  await ensureDefaultOrganizationForUser(db, userId, displayName)

  const normalizedName = name.trim()
  const now = new Date()
  const [inserted] = await db
    .insert(projects)
    .values({
      id: nanoid(),
      owner_id: userId,
      name: normalizedName,
      slug: await uniqueOrganizationSlug(db, normalizedName),
      is_default: false,
      created_at: now,
    })
    .returning()
  if (inserted) {
    await ensureOwnerMembership(db, inserted.id, userId, now)
    await ensureFreeOrgSubscription(db, inserted.id)
  }

  if (!inserted) throw new Error("failed to insert organization")
  return toSummary(inserted)
}

export type SlugFrozenReason = "not_pristine" | "not_requested"

export type RenameOrganizationResult =
  | {
      ok: true
      organization: OrganizationSummary
      slug_changed: boolean
      previous_slug: string
      slug_frozen_reason: SlugFrozenReason | null
    }
  | { ok: false; reason: "not_found" | "slug_conflict" }

/**
 * A workspace may only change its slug while nothing external pins it.
 *
 * The blocking set is deliberately narrow: `sso_configs.redirect_uri` embeds
 * the slug and is registered inside the customer's IdP, outbound webhook
 * payloads carry `org_slug`, and anything deployed means links are in the wild.
 * Env vars, secrets and branding create no external coupling, so they must not
 * block a rename.
 */
async function isWorkspacePristine(
  db: Pick<Db, "select">,
  orgId: string
): Promise<boolean> {
  const [appRows, dbRows, serviceRows, ssoRows, hookRows, jobRows, memberRows] =
    await Promise.all([
      db
        .select({ id: apps.id })
        .from(apps)
        .where(eq(apps.project_id, orgId))
        .limit(1),
      db
        .select({ id: databases.id })
        .from(databases)
        .where(eq(databases.project_id, orgId))
        .limit(1),
      db
        .select({ id: services.id })
        .from(services)
        .where(eq(services.project_id, orgId))
        .limit(1),
      db
        .select({ id: sso_configs.id })
        .from(sso_configs)
        .where(eq(sso_configs.org_id, orgId))
        .limit(1),
      db
        .select({ id: eventWebhooks.id })
        .from(eventWebhooks)
        .where(eq(eventWebhooks.org_id, orgId))
        .limit(1),
      db
        .select({ id: scheduled_jobs.id })
        .from(scheduled_jobs)
        .where(eq(scheduled_jobs.org_id, orgId))
        .limit(1),
      db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.org_id, orgId))
        .limit(2),
    ])

  if (appRows[0] || dbRows[0] || serviceRows[0]) return false
  if (ssoRows[0] || hookRows[0] || jobRows[0]) return false
  // A second member means someone else may already hold a link to this slug.
  return memberRows.length <= 1
}

/**
 * Rename a workspace, regenerating the slug only while the workspace is
 * pristine. Authorization is handled upstream by requireRole(["owner"]).
 */
export async function renameOrganizationForUser(
  db: Db,
  slug: string,
  name: string,
  reslug: boolean
): Promise<RenameOrganizationResult> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1)
  const project = rows[0]
  if (!project) return { ok: false, reason: "not_found" }

  const normalizedName = name.trim()

  let frozenReason: SlugFrozenReason | null = null
  if (!reslug) {
    frozenReason = "not_requested"
  } else if (!(await isWorkspacePristine(db, project.id))) {
    frozenReason = "not_pristine"
  }

  if (frozenReason !== null) {
    const [updated] = await db
      .update(projects)
      .set({ name: normalizedName })
      .where(eq(projects.id, project.id))
      .returning()
    if (!updated) return { ok: false, reason: "not_found" }
    return {
      ok: true,
      organization: toSummary(updated),
      slug_changed: false,
      previous_slug: project.slug,
      slug_frozen_reason: frozenReason,
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const nextSlug = await uniqueOrganizationSlug(db, normalizedName)
    try {
      const [updated] = await db
        .update(projects)
        .set({ name: normalizedName, slug: nextSlug })
        .where(eq(projects.id, project.id))
        .returning()
      if (!updated) return { ok: false, reason: "not_found" }
      return {
        ok: true,
        organization: toSummary(updated),
        slug_changed: updated.slug !== project.slug,
        previous_slug: project.slug,
        slug_frozen_reason: null,
      }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
    }
  }
  return { ok: false, reason: "slug_conflict" }
}

export async function getOrganizationBySlugForUser(
  db: Db,
  userId: string,
  slug: string
): Promise<OrganizationSummary | null> {
  try {
    const rows = await db
      .select()
      .from(projects)
      .innerJoin(
        memberships,
        and(
          eq(memberships.org_id, projects.id),
          eq(memberships.user_id, userId),
          isNotNull(memberships.accepted_at)
        )
      )
      .where(eq(projects.slug, slug))
      .limit(1)

    if (rows[0]) return toSummary(rows[0].projects)
  } catch {
    // memberships table missing — fall through to owner_id lookup below.
  }

  // Backfill safety : if the user is the owner_id of this slug but has no
  // membership row (legacy), create it now and return the project.
  const ownerRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.slug, slug), eq(projects.owner_id, userId)))
    .limit(1)

  if (!ownerRows[0]) return null
  await ensureOwnerMembership(
    db,
    ownerRows[0].id,
    userId,
    ownerRows[0].created_at ?? new Date()
  )
  return toSummary(ownerRows[0])
}

export async function getDefaultOrganizationForUser(
  db: Db,
  userId: string,
  displayName?: string | null
): Promise<OrganizationSummary> {
  const row = await ensureDefaultOrganizationForUser(db, userId, displayName)
  return toSummary(row)
}

export type DeleteOrganizationResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "forbidden" }

/**
 * Hard-delete a workspace (project) the user owns.
 *
 * Authorization: the user must either be the project's `owner_id` or hold an
 * `owner` membership. Cascade deletes are wired in the schema so apps,
 * databases, env vars, etc. go with it. Caller is expected to redirect to
 * another workspace afterwards (or `/dashboard`, which lazily provisions a
 * default).
 */
export async function deleteOrganizationForUser(
  db: Db,
  userId: string,
  slug: string
): Promise<DeleteOrganizationResult> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1)
  const project = rows[0]
  if (!project) return { ok: false, reason: "not_found" }

  if (project.owner_id !== userId) {
    let isOwnerMember = false
    try {
      const member = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.org_id, project.id),
            eq(memberships.user_id, userId),
            isNotNull(memberships.accepted_at)
          )
        )
        .limit(1)
      isOwnerMember = member[0]?.role === "owner"
    } catch {
      // memberships table missing — owner_id check above already failed.
    }
    if (!isOwnerMember) return { ok: false, reason: "forbidden" }
  }

  await db.delete(projects).where(eq(projects.id, project.id))
  return { ok: true }
}
