// SPDX-License-Identifier: AGPL-3.0-only
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  min,
  notInArray,
  or,
  sql,
} from "drizzle-orm"
import { provider_installations, provider_repos } from "../schema"
import type { Db } from "../client"
import type { InferSelectModel } from "drizzle-orm"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderInstallationRow = InferSelectModel<
  typeof provider_installations
>
export type ProviderRepoRow = InferSelectModel<typeof provider_repos>
/** An unknown App (undefined) never overwrites an installation's stored App. */
export type ProviderInstallationInput = Omit<
  ProviderInstallationRow,
  "github_app_id"
> & { github_app_id?: string | null | undefined }

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export async function listRepos(
  db: Db,
  opts: {
    provider: "github" | "gitlab"
    installationIds?: string[]
    search?: string
    limit: number
    offset: number
  }
): Promise<{ rows: ProviderRepoRow[]; total: number }> {
  const { provider, search, limit, offset, installationIds } = opts
  if (installationIds?.length === 0) return { rows: [], total: 0 }

  const providerFilter = eq(provider_repos.provider, provider)
  const searchFilter = search
    ? or(
        sql`${provider_repos.full_name} ILIKE ${`%${search}%`}`,
        sql`${provider_repos.description} ILIKE ${`%${search}%`}`
      )
    : undefined

  const installationFilter = installationIds
    ? inArray(provider_repos.installation_id, installationIds)
    : undefined
  const where = and(providerFilter, searchFilter, installationFilter)

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(provider_repos)
      .where(where)
      .orderBy(
        sql`${provider_repos.pushed_at} DESC NULLS LAST`,
        asc(provider_repos.full_name)
      )
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(provider_repos).where(where),
  ])

  return { rows, total: totalRow?.total ?? 0 }
}

// ---------------------------------------------------------------------------
// Installations
// ---------------------------------------------------------------------------

export async function upsertInstallation(
  db: Db,
  row: ProviderInstallationInput
): Promise<void> {
  await db
    .insert(provider_installations)
    .values(row)
    .onConflictDoUpdate({
      target: [
        provider_installations.provider,
        provider_installations.external_id,
      ],
      set: {
        id: row.id,
        provider: row.provider,
        external_id: row.external_id,
        account_login: row.account_login,
        account_type: row.account_type,
        repository_selection: row.repository_selection,
        suspended_at: row.suspended_at,
        html_url: row.html_url,
        avatar_url: row.avatar_url,
        repository_count: row.repository_count,
        ...(row.github_app_id !== undefined
          ? { github_app_id: row.github_app_id }
          : {}),
        last_synced_at: sql`now()`,
      },
    })
}

/**
 * Records which GitHub App owns an installation without publishing sync
 * freshness: a new row starts never-synced, an existing row keeps its
 * snapshot. Token issuance needs this link before the first repo page.
 */
export async function bindGitHubInstallationApp(
  db: Db,
  row: ProviderInstallationInput & { github_app_id: string }
): Promise<void> {
  await db
    .insert(provider_installations)
    .values({ ...row, last_synced_at: new Date(0) })
    .onConflictDoUpdate({
      target: [
        provider_installations.provider,
        provider_installations.external_id,
      ],
      set: { github_app_id: row.github_app_id },
    })
}

export async function deleteInstallation(db: Db, id: string): Promise<void> {
  await db
    .delete(provider_installations)
    .where(eq(provider_installations.id, id))
}

export async function listInstallations(
  db: Db,
  provider: "github" | "gitlab",
  installationIds?: string[]
): Promise<ProviderInstallationRow[]> {
  if (installationIds?.length === 0) return []
  return db
    .select()
    .from(provider_installations)
    .where(
      and(
        eq(provider_installations.provider, provider),
        installationIds
          ? inArray(provider_installations.id, installationIds)
          : undefined
      )
    )
}

export async function getInstallationStaleness(
  db: Db,
  provider: "github" | "gitlab",
  installationIds?: string[]
): Promise<{ mostStaleAt: Date | null; count: number }> {
  if (installationIds?.length === 0) return { mostStaleAt: null, count: 0 }
  const [row] = await db
    .select({
      mostStaleAt: min(provider_installations.last_synced_at),
      count: count(),
    })
    .from(provider_installations)
    .where(
      and(
        eq(provider_installations.provider, provider),
        installationIds
          ? inArray(provider_installations.id, installationIds)
          : undefined
      )
    )

  return {
    mostStaleAt: row?.mostStaleAt ?? null,
    count: row?.count ?? 0,
  }
}

export interface CacheStatusRow {
  id: string
  externalId: string
  accountLogin: string
  avatarUrl: string | null
  htmlUrl: string | null
  lastSyncedAt: Date
  repoCount: number
}

export async function getCacheStatus(
  db: Db,
  provider: "github" | "gitlab",
  installationIdFilter?: string | string[]
): Promise<CacheStatusRow[]> {
  if (Array.isArray(installationIdFilter) && installationIdFilter.length === 0)
    return []
  const where =
    typeof installationIdFilter === "string"
      ? and(
          eq(provider_installations.provider, provider),
          eq(provider_installations.id, installationIdFilter)
        )
      : and(
          eq(provider_installations.provider, provider),
          Array.isArray(installationIdFilter)
            ? inArray(provider_installations.id, installationIdFilter)
            : undefined
        )

  const rows = await db
    .select({
      id: provider_installations.id,
      externalId: provider_installations.external_id,
      accountLogin: provider_installations.account_login,
      avatarUrl: provider_installations.avatar_url,
      htmlUrl: provider_installations.html_url,
      lastSyncedAt: provider_installations.last_synced_at,
      repoCount: sql<number>`count(${provider_repos.id})::int`,
    })
    .from(provider_installations)
    .leftJoin(
      provider_repos,
      eq(provider_repos.installation_id, provider_installations.id)
    )
    .where(where)
    .groupBy(provider_installations.id)
    .orderBy(asc(provider_installations.account_login))

  return rows
}

// ---------------------------------------------------------------------------
// Repos mutations
// ---------------------------------------------------------------------------

export async function upsertRepos(
  db: Db,
  rows: ProviderRepoRow[]
): Promise<void> {
  if (rows.length === 0) return

  await db
    .insert(provider_repos)
    .values(rows)
    .onConflictDoUpdate({
      target: [provider_repos.installation_id, provider_repos.id],
      set: {
        provider: sql`excluded.provider`,
        full_name: sql`excluded.full_name`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        default_branch: sql`excluded.default_branch`,
        private: sql`excluded.private`,
        html_url: sql`excluded.html_url`,
        pushed_at: sql`excluded.pushed_at`,
        updated_at: sql`excluded.updated_at`,
        last_synced_at: sql`now()`,
      },
    })
}

export async function deleteRepos(
  db: Db,
  installationId: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return

  await db
    .delete(provider_repos)
    .where(
      and(
        eq(provider_repos.installation_id, installationId),
        inArray(provider_repos.id, ids)
      )
    )
}

export async function replaceInstallationRepos(
  db: Db,
  installationId: string,
  rows: ProviderRepoRow[]
): Promise<void> {
  await db.transaction(async (tx) => {
    await replaceInstallationReposInTransaction(
      tx as unknown as Db,
      installationId,
      rows
    )
  })
}

async function replaceInstallationReposInTransaction(
  db: Db,
  installationId: string,
  rows: ProviderRepoRow[]
): Promise<void> {
  await upsertRepos(db, rows)

  if (rows.length > 0) {
    const upsertedIds = rows.map((r) => r.id)
    await db
      .delete(provider_repos)
      .where(
        and(
          eq(provider_repos.installation_id, installationId),
          notInArray(provider_repos.id, upsertedIds)
        )
      )
  } else {
    await db
      .delete(provider_repos)
      .where(eq(provider_repos.installation_id, installationId))
  }
}

/** Atomically publishes installation freshness and its complete repository set. */
export async function replaceInstallationSnapshot(
  db: Db,
  installation: ProviderInstallationInput,
  rows: ProviderRepoRow[]
): Promise<void> {
  await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as Db
    await upsertInstallation(transactionDb, installation)
    await replaceInstallationReposInTransaction(
      transactionDb,
      installation.id,
      rows
    )
  })
}
