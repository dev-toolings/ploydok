// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from '../client';
import { randomUUID } from "node:crypto"
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm"
import {
  github_app,
  github_installation_legacy_backfill,
  github_installation_users,
  memberships,
  org_github_installations,
  provider_installations,
  provider_credentials,
} from "../schema"

function githubInstallationExternalId(installationId: string): string {
  return installationId.startsWith("github:")
    ? installationId.slice("github:".length)
    : installationId
}

export type GitHubAppRow = typeof github_app.$inferSelect

export interface GitHubAppConfig {
  app_id: string;
  client_id: string;
  slug: string;
  name: string;
  owner_login?: string | null;
  owner_type?: string | null;
  client_secret_enc: Buffer;
  client_secret_nonce: Buffer;
  pem_enc: Buffer;
  pem_nonce: Buffer;
  webhook_secret_enc: Buffer;
  webhook_secret_nonce: Buffer;
}

/** Lists every registered GitHub App, oldest first. */
export async function listGitHubAppConfigs(db: Db): Promise<GitHubAppRow[]> {
  return db
    .select()
    .from(github_app)
    .orderBy(asc(github_app.created_at), asc(github_app.id))
}

/**
 * Returns one GitHub App: the given row id, or the oldest App when no id is
 * passed (readiness checks that only need to know an App exists).
 */
export async function getGitHubAppConfig(
  db: Db,
  id?: string
): Promise<GitHubAppRow | null> {
  if (id) {
    const rows = await db
      .select()
      .from(github_app)
      .where(eq(github_app.id, id))
      .limit(1)
    return rows[0] ?? null
  }
  const rows = await db
    .select()
    .from(github_app)
    .orderBy(asc(github_app.created_at), asc(github_app.id))
    .limit(1)
  return rows[0] ?? null
}

/** Resolves an App from GitHub's numeric App id (webhook target header). */
export async function getGitHubAppConfigByAppId(
  db: Db,
  appId: string
): Promise<GitHubAppRow | null> {
  const rows = await db
    .select()
    .from(github_app)
    .where(eq(github_app.app_id, appId))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Resolves the App that owns an installation. An installation recorded before
 * its App was known falls back to the only App, never to an arbitrary one.
 */
export async function getGitHubAppConfigForInstallation(
  db: Db,
  installationId: string
): Promise<GitHubAppRow | null> {
  const externalId = githubInstallationExternalId(installationId)
  const linked = await db
    .select({ app: github_app })
    .from(provider_installations)
    .innerJoin(github_app, eq(github_app.id, provider_installations.github_app_id))
    .where(
      and(
        eq(provider_installations.provider, "github"),
        eq(provider_installations.external_id, externalId)
      )
    )
    .limit(1)
  if (linked[0]) return linked[0].app
  const apps = await db.select().from(github_app).limit(2)
  return apps.length === 1 ? apps[0]! : null
}

/**
 * Serializes replacement/reset writes on one App and locks its row. The table
 * lock also covers the case where the row is already gone. Must be called
 * inside a transaction.
 */
export async function lockGitHubAppConfigForReset(
  db: Db,
  id: string
): Promise<GitHubAppRow | null> {
  await db.execute(
    sql`LOCK TABLE ${github_app} IN SHARE ROW EXCLUSIVE MODE`
  )
  const rows = await db
    .select()
    .from(github_app)
    .where(eq(github_app.id, id))
    .limit(1)
    .for("update")
  return rows[0] ?? null
}

/** Locks one App against reset/re-import for a short side effect. */
export async function lockGitHubAppConfigForUse(
  db: Db,
  id: string
): Promise<GitHubAppRow | null> {
  const rows = await db
    .select()
    .from(github_app)
    .where(eq(github_app.id, id))
    .limit(1)
    .for("share")
  return rows[0] ?? null
}

/** Locks every App against reset/re-import (cross-App fan-out side effects). */
export async function lockGitHubAppConfigsForUse(
  db: Db
): Promise<GitHubAppRow[]> {
  return db
    .select()
    .from(github_app)
    .orderBy(asc(github_app.created_at), asc(github_app.id))
    .for("share")
}

/**
 * Stores an App, keyed by its GitHub App id: re-importing an App updates its
 * existing row (and keeps its installations), a new App gets a new row.
 * Returns the row id.
 */
export async function saveGitHubAppConfig(
  db: Db,
  cfg: GitHubAppConfig
): Promise<string> {
  const set = {
    client_id: cfg.client_id,
    slug: cfg.slug,
    name: cfg.name,
    ...(cfg.owner_login !== undefined ? { owner_login: cfg.owner_login } : {}),
    ...(cfg.owner_type !== undefined ? { owner_type: cfg.owner_type } : {}),
    client_secret_enc: cfg.client_secret_enc,
    client_secret_nonce: cfg.client_secret_nonce,
    pem_enc: cfg.pem_enc,
    pem_nonce: cfg.pem_nonce,
    webhook_secret_enc: cfg.webhook_secret_enc,
    webhook_secret_nonce: cfg.webhook_secret_nonce,
  }
  const rows = await db
    .insert(github_app)
    .values({
      id: `ghapp_${randomUUID()}`,
      app_id: cfg.app_id,
      owner_login: cfg.owner_login ?? null,
      owner_type: cfg.owner_type ?? null,
      ...set,
    })
    .onConflictDoUpdate({ target: github_app.app_id, set })
    .returning({ id: github_app.id })
  return rows[0]!.id
}

/** Deletes one App row; its installations cascade. */
export async function deleteGitHubAppConfig(db: Db, id: string): Promise<void> {
  await db.delete(github_app).where(eq(github_app.id, id));
}

/**
 * Deletes every local record owned by one GitHub App. Installations recorded
 * before their App was known are removed with the last App.
 */
export async function deleteGitHubAppLocalState(
  db: Db,
  id: string
): Promise<void> {
  const others = await db
    .select({ id: github_app.id })
    .from(github_app)
    .where(ne(github_app.id, id))
    .limit(1)
  const owned = and(
    eq(provider_installations.provider, "github"),
    others.length === 0
      ? or(
          eq(provider_installations.github_app_id, id),
          isNull(provider_installations.github_app_id)
        )
      : eq(provider_installations.github_app_id, id)
  )
  const installations = await db
    .select({
      id: provider_installations.id,
      external_id: provider_installations.external_id,
    })
    .from(provider_installations)
    .where(owned)
  const dbIds = installations.map((row) => row.id)
  const externalIds = installations.map((row) => row.external_id)

  if (others.length === 0) {
    await db
      .delete(provider_credentials)
      .where(eq(provider_credentials.provider, "github"))
    await db.delete(github_installation_users)
    await db
      .update(github_installation_legacy_backfill)
      .set({ consumed_at: new Date() })
      .where(isNull(github_installation_legacy_backfill.consumed_at))
  } else if (dbIds.length > 0) {
    await db
      .delete(provider_credentials)
      .where(inArray(provider_credentials.id, dbIds))
    await db
      .delete(github_installation_users)
      .where(
        inArray(github_installation_users.installation_id, [
          ...externalIds,
          ...dbIds,
        ])
      )
    await db
      .update(github_installation_legacy_backfill)
      .set({ consumed_at: new Date() })
      .where(
        and(
          isNull(github_installation_legacy_backfill.consumed_at),
          inArray(github_installation_legacy_backfill.installation_id, externalIds)
        )
      )
  }
  if (dbIds.length > 0) {
    await db
      .delete(provider_installations)
      .where(inArray(provider_installations.id, dbIds))
  }
  await db.delete(github_app).where(eq(github_app.id, id))
}

export async function assignGitHubInstallationToUser(
  db: Db,
  installationId: string,
  userId: string
): Promise<void> {
  const now = new Date()
  await db
    .insert(github_installation_users)
    .values({
      installation_id: installationId,
      user_id: userId,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing()
}

export async function hasGitHubInstallationForUser(
  db: Db,
  userId: string
): Promise<boolean> {
  const rows = await db
    .select({ installation_id: github_installation_users.installation_id })
    .from(github_installation_users)
    .where(eq(github_installation_users.user_id, userId))
    .limit(1)
  return rows.length > 0
}

export async function listGitHubInstallationIdsForUser(
  db: Db,
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ installation_id: github_installation_users.installation_id })
    .from(github_installation_users)
    .where(eq(github_installation_users.user_id, userId))
  return rows.map((row) => row.installation_id)
}

export async function userOwnsGitHubInstallation(
  db: Db,
  userId: string,
  installationId: string
): Promise<boolean> {
  const rows = await db
    .select({ installation_id: github_installation_users.installation_id })
    .from(github_installation_users)
    .where(
      and(
        eq(github_installation_users.user_id, userId),
        eq(github_installation_users.installation_id, installationId)
      )
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Checks a caller's personal GitHub installation link. Organization
 * installations must be authorized through an explicit workspace grant.
 */
export async function userOwnsPersonalGitHubInstallation(
  db: Db,
  userId: string,
  installationId: string
): Promise<boolean> {
  const externalId = githubInstallationExternalId(installationId)
  const rows = await db
    .select({ installation_id: github_installation_users.installation_id })
    .from(github_installation_users)
    .innerJoin(
      provider_installations,
      or(
        eq(
          provider_installations.id,
          githubInstallationDbId(externalId)
        ),
        eq(provider_installations.external_id, externalId)
      )
    )
    .where(
      and(
        eq(github_installation_users.user_id, userId),
        or(
          eq(github_installation_users.installation_id, externalId),
          eq(
            github_installation_users.installation_id,
            `github:${externalId}`
          )
        ),
        eq(provider_installations.provider, "github"),
        eq(provider_installations.account_type, "User")
      )
    )
    .limit(1)
  return rows.length > 0
}

function githubInstallationDbId(installationId: string): string {
  return installationId.startsWith("github:")
    ? installationId
    : `github:${installationId}`
}

/** Grants an installation to one Ploydok organization. */
export async function grantGitHubInstallationToOrganization(
  db: Db,
  orgId: string,
  installationId: string,
  grantedBy: string
): Promise<void> {
  const now = new Date()
  await db
    .insert(org_github_installations)
    .values({
      org_id: orgId,
      installation_id: githubInstallationDbId(installationId),
      granted_by: grantedBy,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        org_github_installations.org_id,
        org_github_installations.installation_id,
      ],
      set: { granted_by: grantedBy, updated_at: now },
    })
}

/** Removes an organization's explicit grant without touching the installation. */
export async function revokeGitHubInstallationFromOrganization(
  db: Db,
  orgId: string,
  installationId: string
): Promise<boolean> {
  const rows = await db
    .delete(org_github_installations)
    .where(
      and(
        eq(org_github_installations.org_id, orgId),
        eq(
          org_github_installations.installation_id,
          githubInstallationDbId(installationId)
        )
      )
    )
    .returning({ org_id: org_github_installations.org_id })
  return rows.length > 0
}

/** Checks only explicit organization grants, never a caller's personal link. */
export async function organizationHasGitHubInstallationGrant(
  db: Db,
  orgId: string,
  installationId: string
): Promise<boolean> {
  const rows = await db
    .select({ org_id: org_github_installations.org_id })
    .from(org_github_installations)
    .where(
      and(
        eq(org_github_installations.org_id, orgId),
        eq(
          org_github_installations.installation_id,
          githubInstallationDbId(installationId)
        )
      )
    )
    .limit(1)
  return rows.length > 0
}

export async function listGitHubInstallationIdsForOrganization(
  db: Db,
  orgId: string
): Promise<string[]> {
  const rows = await db
    .select({ installation_id: org_github_installations.installation_id })
    .from(org_github_installations)
    .where(eq(org_github_installations.org_id, orgId))
  return rows.map((row) => row.installation_id.replace(/^github:/, ""))
}

/** Lists organization grants plus the caller's own personal GitHub install. */
export async function listGitHubInstallationIdsForOrganizationAndUser(
  db: Db,
  orgId: string,
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ installation_id: org_github_installations.installation_id })
    .from(org_github_installations)
    .where(eq(org_github_installations.org_id, orgId))

  const personalRows = await db
    .select({ installation_id: provider_installations.external_id })
    .from(github_installation_users)
    .innerJoin(
      provider_installations,
      or(
        eq(
          provider_installations.id,
          sql`'github:' || regexp_replace(${github_installation_users.installation_id}, '^github:', '')`
        ),
        eq(
          provider_installations.external_id,
          sql`regexp_replace(${github_installation_users.installation_id}, '^github:', '')`
        )
      )
    )
    .where(
      and(
        eq(github_installation_users.user_id, userId),
        eq(provider_installations.provider, "github"),
        eq(provider_installations.account_type, "User")
      )
    )

  return Array.from(
    new Set(
      [...rows.map((row) => row.installation_id),
        ...personalRows.map((row) => row.installation_id),
      ].map((id) => id.replace(/^github:/, ""))
    )
  )
}

/**
 * Delivers the one-time organization grants for callback links that existed
 * before the provider installation cache had a row. The migration inserts
 * markers only for that historical orphan set. Markers are consumed even when
 * the user no longer owns an accepted organization, which prevents a removed
 * link from being re-shared if it is later added again.
 */
export async function backfillLegacyGitHubInstallationGrants(
  db: Db,
  installationId: string
): Promise<number> {
  const externalId = githubInstallationExternalId(installationId)

  return db.transaction(async (tx) => {
    const markers = await tx
      .select({ user_id: github_installation_legacy_backfill.user_id })
      .from(github_installation_legacy_backfill)
      .where(
        and(
          eq(github_installation_legacy_backfill.installation_id, externalId),
          isNull(github_installation_legacy_backfill.consumed_at)
        )
      )
      .for("update")

    if (markers.length === 0) return 0

    let grantCount = 0
    const consumedAt = new Date()
    for (const marker of markers) {
      const links = await tx
        .select({ installation_id: github_installation_users.installation_id })
        .from(github_installation_users)
        .where(
          and(
            eq(github_installation_users.user_id, marker.user_id),
            or(
              eq(github_installation_users.installation_id, externalId),
              eq(
                github_installation_users.installation_id,
                `github:${externalId}`
              )
            )
          )
        )
        .limit(1)

      // A removed legacy link must not be re-shared if it is later recreated.
      if (links.length === 0) continue

      const owners = await tx
        .select({ org_id: memberships.org_id })
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, marker.user_id),
            eq(memberships.role, "owner"),
            isNotNull(memberships.accepted_at)
          )
        )

      if (owners.length > 0) {
        await tx
          .insert(org_github_installations)
          .values(
            owners.map((owner) => ({
              org_id: owner.org_id,
              installation_id: githubInstallationDbId(externalId),
              granted_by: marker.user_id,
              created_at: consumedAt,
              updated_at: consumedAt,
            }))
          )
          .onConflictDoNothing()
        grantCount += owners.length
      }
    }

    await tx
      .update(github_installation_legacy_backfill)
      .set({ consumed_at: consumedAt })
      .where(
        and(
          eq(github_installation_legacy_backfill.installation_id, externalId),
          isNull(github_installation_legacy_backfill.consumed_at)
        )
      )

    return grantCount
  })
}

export async function deleteGitHubInstallationUser(
  db: Db,
  installationId: string
): Promise<void> {
  await db
    .delete(github_installation_users)
    .where(
      or(
        eq(
          github_installation_users.installation_id,
          githubInstallationExternalId(installationId)
        ),
        eq(
          github_installation_users.installation_id,
          `github:${githubInstallationExternalId(installationId)}`
        )
      )
    )
  await db
    .update(github_installation_legacy_backfill)
    .set({ consumed_at: new Date() })
    .where(
      and(
        eq(
          github_installation_legacy_backfill.installation_id,
          githubInstallationExternalId(installationId)
        ),
        isNull(github_installation_legacy_backfill.consumed_at)
      )
    )
}

export async function deleteGitHubInstallationUserForUser(
  db: Db,
  installationId: string,
  userId: string
): Promise<void> {
  await db
    .delete(github_installation_users)
    .where(
      and(
        or(
          eq(
            github_installation_users.installation_id,
            githubInstallationExternalId(installationId)
          ),
          eq(
            github_installation_users.installation_id,
            `github:${githubInstallationExternalId(installationId)}`
          )
        ),
        eq(github_installation_users.user_id, userId)
      )
    )
  await db
    .update(github_installation_legacy_backfill)
    .set({ consumed_at: new Date() })
    .where(
      and(
        eq(
          github_installation_legacy_backfill.installation_id,
          githubInstallationExternalId(installationId)
        ),
        eq(github_installation_legacy_backfill.user_id, userId),
        isNull(github_installation_legacy_backfill.consumed_at)
      )
    )
}

/** Atomically removes an uninstalled GitHub installation and every user link. */
export async function deleteGitHubInstallationAndUsers(
  db: Db,
  installationId: string
): Promise<void> {
  const externalId = githubInstallationExternalId(installationId)
  await db.transaction(async (tx) => {
    await tx
      .update(github_installation_legacy_backfill)
      .set({ consumed_at: new Date() })
      .where(
        and(
          eq(github_installation_legacy_backfill.installation_id, externalId),
          isNull(github_installation_legacy_backfill.consumed_at)
        )
      )
    await tx
      .delete(github_installation_users)
      .where(
        or(
          eq(github_installation_users.installation_id, externalId),
          eq(
            github_installation_users.installation_id,
            `github:${externalId}`
          )
        )
      )
    await tx
      .delete(provider_installations)
      .where(eq(provider_installations.id, `github:${externalId}`))
  })
}

export async function deleteGitHubInstallationUsers(db: Db): Promise<void> {
  await db.delete(github_installation_users)
  await db
    .update(github_installation_legacy_backfill)
    .set({ consumed_at: new Date() })
    .where(isNull(github_installation_legacy_backfill.consumed_at))
}
