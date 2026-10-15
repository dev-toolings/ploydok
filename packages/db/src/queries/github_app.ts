// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from '../client';
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm"
import {
  github_app,
  github_installation_legacy_backfill,
  github_installation_users,
  memberships,
  org_github_installations,
  provider_installations,
  provider_credentials,
} from "../schema"

const SINGLETON_ID = 'singleton';

function githubInstallationExternalId(installationId: string): string {
  return installationId.startsWith("github:")
    ? installationId.slice("github:".length)
    : installationId
}

export interface GitHubAppConfig {
  app_id: string;
  client_id: string;
  slug: string;
  name: string;
  client_secret_enc: Buffer;
  client_secret_nonce: Buffer;
  pem_enc: Buffer;
  pem_nonce: Buffer;
  webhook_secret_enc: Buffer;
  webhook_secret_nonce: Buffer;
}

/** Returns the stored GitHub App config, or null if not yet created. */
export async function getGitHubAppConfig(db: Db): Promise<(typeof github_app.$inferSelect) | null> {
  const rows = await db
    .select()
    .from(github_app)
    .where(eq(github_app.id, SINGLETON_ID))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Serializes GitHub App replacement/reset writes and locks the singleton row.
 * The table lock also covers the not-configured case, where no row exists for
 * SELECT FOR UPDATE to lock. Must be called inside a transaction.
 */
export async function lockGitHubAppConfigForReset(
  db: Db
): Promise<(typeof github_app.$inferSelect) | null> {
  await db.execute(
    sql`LOCK TABLE ${github_app} IN SHARE ROW EXCLUSIVE MODE`
  )
  const rows = await db
    .select()
    .from(github_app)
    .where(eq(github_app.id, SINGLETON_ID))
    .limit(1)
    .for("update")
  return rows[0] ?? null
}

/** Locks the current singleton against reset/re-import for a short side effect. */
export async function lockGitHubAppConfigForUse(
  db: Db
): Promise<(typeof github_app.$inferSelect) | null> {
  const rows = await db
    .select()
    .from(github_app)
    .where(eq(github_app.id, SINGLETON_ID))
    .limit(1)
    .for("share")
  return rows[0] ?? null
}

/** Upserts the singleton GitHub App config. */
export async function saveGitHubAppConfig(db: Db, cfg: GitHubAppConfig): Promise<void> {
  const row = {
    id: SINGLETON_ID,
    app_id: cfg.app_id,
    client_id: cfg.client_id,
    slug: cfg.slug,
    name: cfg.name,
    client_secret_enc: cfg.client_secret_enc,
    client_secret_nonce: cfg.client_secret_nonce,
    pem_enc: cfg.pem_enc,
    pem_nonce: cfg.pem_nonce,
    webhook_secret_enc: cfg.webhook_secret_enc,
    webhook_secret_nonce: cfg.webhook_secret_nonce,
  };

  await db
    .insert(github_app)
    .values(row)
    .onConflictDoUpdate({
      target: github_app.id,
      set: {
        app_id: row.app_id,
        client_id: row.client_id,
        slug: row.slug,
        name: row.name,
        client_secret_enc: row.client_secret_enc,
        client_secret_nonce: row.client_secret_nonce,
        pem_enc: row.pem_enc,
        pem_nonce: row.pem_nonce,
        webhook_secret_enc: row.webhook_secret_enc,
        webhook_secret_nonce: row.webhook_secret_nonce,
      },
    });
}

/** Deletes the singleton GitHub App config (used by the reset flow). */
export async function deleteGitHubAppConfig(db: Db): Promise<void> {
  await db.delete(github_app).where(eq(github_app.id, SINGLETON_ID));
}

/** Deletes every local record owned by the GitHub App integration. */
export async function deleteGitHubAppLocalState(db: Db): Promise<void> {
  await db
    .delete(provider_credentials)
    .where(eq(provider_credentials.provider, "github"))
  await db
    .delete(provider_installations)
    .where(eq(provider_installations.provider, "github"))
  await db.delete(github_installation_users)
  await db
    .update(github_installation_legacy_backfill)
    .set({ consumed_at: new Date() })
    .where(isNull(github_installation_legacy_backfill.consumed_at))
  await db.delete(github_app).where(eq(github_app.id, SINGLETON_ID))
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
