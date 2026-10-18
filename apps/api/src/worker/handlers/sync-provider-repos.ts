// SPDX-License-Identifier: AGPL-3.0-only
import {
  backfillLegacyGitHubInstallationGrants,
  bindGitHubInstallationApp,
  replaceInstallationSnapshot,
  getGitHubAppConfigForInstallation,
  listGitHubAppConfigs,
  lockGitHubAppConfigsForUse,
} from "@ploydok/db/queries"
import type { ProviderCredentialRow } from "@ploydok/db"
import type {
  ProviderInstallationInput,
  ProviderRepoRow,
} from "@ploydok/db/queries"
import type { Db } from "@ploydok/db"
import {
  gitlab_tokens,
  provider_credentials,
  provider_installations,
} from "@ploydok/db"
import { and, eq, notInArray, sql } from "drizzle-orm"
import { listAppInstallations } from "../../github/installation-tokens"
import { ghProvider } from "../../routes/github"
import { resolveGitLabConnection } from "../../gitlab/connection"
import { getGitHubAppsFingerprint } from "../../github/config-fingerprint"
import { workerLog } from "../logger"
import { providerReposSyncQueue } from "../queues"
import { eventBus } from "../event-bus"
import { writeSyncTargetStatus } from "../provider-sync-status"
import { auditClaimed, auditUnauthorized } from "../queue-audit.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// `requestedBy` (optional) is the userId of the human who clicked Sync — used
// to scope progress events to their SSE channel. `syncId` is a per-click
// correlation id so the front can ignore events from concurrent syncs.
export type SyncProviderReposPayload =
  | {
      provider: "github"
      installationId?: string
      requestedBy?: string
      syncId?: string
    }
  | {
      provider: "gitlab"
      userId?: string
      requestedBy?: string
      syncId?: string
    }

// ---------------------------------------------------------------------------
// Enqueue helper (public — T2B/T2C depend on this)
// ---------------------------------------------------------------------------

export async function enqueueProviderReposSync(
  payload: SyncProviderReposPayload
): Promise<void> {
  const normalizedPayload =
    payload.provider === "github" && payload.installationId
      ? {
          ...payload,
          installationId: normalizeGitHubInstallationId(payload.installationId),
        }
      : payload

  // BullMQ rejects ":" in custom job ids (Redis key separator). Use "-".
  const target =
    normalizedPayload.provider === "github"
      ? `github-${normalizedPayload.installationId ?? "all"}`
      : `gitlab-${normalizedPayload.userId ?? "all"}`
  // Suffix with timestamp so repeated manual syncs each enqueue a fresh job
  // instead of being deduped against an already-running one.
  const jobId = `${target}-${Date.now()}`
  if (
    normalizedPayload.requestedBy &&
    normalizedPayload.syncId &&
    target !== "github-all" &&
    target !== "gitlab-all"
  ) {
    await writeSyncTargetStatus(
      normalizedPayload.requestedBy,
      normalizedPayload.syncId,
      target,
      { status: "running" }
    )
  }
  await providerReposSyncQueue.add(target, normalizedPayload, { jobId })
}

// ---------------------------------------------------------------------------
// CAS claim helper
// ---------------------------------------------------------------------------

async function claimProviderCredential(
  db: Db,
  credentialId: string
): Promise<ProviderCredentialRow | null> {
  const result = await db
    .update(provider_credentials)
    .set({
      last_sync_status: "running",
      last_sync_claimed_at: sql`NOW()`,
    })
    .where(
      and(
        eq(provider_credentials.id, credentialId),
        sql`(
          ${provider_credentials.last_sync_status} = 'pending'
          OR (
            ${provider_credentials.last_sync_status} = 'running'
            AND ${provider_credentials.last_sync_claimed_at} < NOW() - INTERVAL '15 minutes'
          )
        )`
      )
    )
    .returning()

  return result[0] ?? null
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleSyncProviderRepos(
  db: Db,
  payload: SyncProviderReposPayload
): Promise<void> {
  const ctx: SyncCtx = {
    syncId: payload.syncId,
    channel: payload.requestedBy ? `user:${payload.requestedBy}` : null,
    requestedBy: payload.requestedBy,
  }

  const target =
    payload.provider === "github"
      ? payload.installationId
        ? `github-${normalizeGitHubInstallationId(payload.installationId)}`
        : null
      : payload.userId
        ? `gitlab-${payload.userId}`
        : null
  let failure: string | undefined
  try {
    if (payload.provider === "github") {
      await syncGitHub(db, payload.installationId, ctx)
    } else {
      await syncGitLab(db, payload.userId, ctx)
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    if (target && payload.requestedBy && payload.syncId) {
      await writeSyncTargetStatus(
        payload.requestedBy,
        payload.syncId,
        target,
        failure !== undefined || ctx.totalRepos === undefined
          ? {
              status: "error",
              error:
                failure ??
                "Sync ended without publishing a repository snapshot",
            }
          : { status: "done", totalRepos: ctx.totalRepos }
      ).catch((err) =>
        workerLog.warn(
          { err, syncId: payload.syncId },
          "failed to persist provider sync result"
        )
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Event-bus plumbing — every progress callsite goes through these helpers so
// the channel/syncId scoping stays consistent.
// ---------------------------------------------------------------------------

interface SyncCtx {
  totalRepos?: number
  syncId: string | undefined
  channel: string | null
  requestedBy: string | undefined
}

function emit(
  ctx: SyncCtx,
  type:
    | "provider.sync.started"
    | "provider.sync.progress"
    | "provider.sync.completed"
    | "provider.sync.failed",
  data: Record<string, unknown>,
  message: string
): void {
  if (
    type === "provider.sync.completed" &&
    typeof data.totalRepos === "number"
  ) {
    ctx.totalRepos = data.totalRepos
  }
  if (!ctx.channel) return
  eventBus.publish(ctx.channel, {
    type,
    message,
    data: { ...data, syncId: ctx.syncId ?? null },
  })
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function normalizeGitHubInstallationId(installationId: string): string {
  return installationId.startsWith("github:")
    ? installationId.slice("github:".length)
    : installationId
}

function getGitHubInstallationDbId(installationId: string): string {
  return `github:${normalizeGitHubInstallationId(installationId)}`
}

function buildLiveGitHubInstallationRow(
  installation: Awaited<ReturnType<typeof listAppInstallations>>[number],
  syncedAt = new Date()
): ProviderInstallationInput {
  const installId = String(installation.id)
  return {
    id: getGitHubInstallationDbId(installId),
    github_app_id: installation.githubAppId,
    provider: "github",
    external_id: installId,
    account_login: installation.accountLogin,
    account_type: installation.accountType,
    repository_selection: installation.repositorySelection,
    suspended_at: installation.suspendedAt
      ? new Date(installation.suspendedAt)
      : null,
    html_url: installation.htmlUrl,
    avatar_url: installation.avatarUrl,
    repository_count: null,
    last_synced_at: syncedAt,
    created_at: syncedAt,
  }
}

async function pruneStaleGitHubInstallations(
  db: Db,
  installations: Awaited<ReturnType<typeof listAppInstallations>>
): Promise<void> {
  const liveDbIds = installations.map((installation) =>
    getGitHubInstallationDbId(String(installation.id))
  )

  const credentialsWhere =
    liveDbIds.length === 0
      ? eq(provider_credentials.provider, "github")
      : and(
          eq(provider_credentials.provider, "github"),
          notInArray(provider_credentials.id, liveDbIds)
        )
  const installationsWhere =
    liveDbIds.length === 0
      ? eq(provider_installations.provider, "github")
      : and(
          eq(provider_installations.provider, "github"),
          notInArray(provider_installations.id, liveDbIds)
        )

  await db.delete(provider_credentials).where(credentialsWhere)
  await db.delete(provider_installations).where(installationsWhere)
}

async function syncGitHub(
  db: Db,
  installationId: string | undefined,
  ctx: SyncCtx
): Promise<void> {
  if (!installationId) {
    await syncGitHubFanOut(db, ctx)
    return
  }
  await syncGitHubInstallation(db, installationId, ctx)
}

async function syncGitHubFanOut(db: Db, ctx: SyncCtx): Promise<void> {
  const initialConfigs = await listGitHubAppConfigs(db)
  if (initialConfigs.length === 0) {
    workerLog.info("github fan-out: App config missing, abandoning")
    return
  }
  const configFingerprint = getGitHubAppsFingerprint(initialConfigs)
  const installations = await listAppInstallations()
  const withConfigFence = async (
    sideEffect: (transactionDb: Db) => Promise<void>
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const transactionDb = tx as unknown as Db
      const currentConfigs = await lockGitHubAppConfigsForUse(transactionDb)
      if (getGitHubAppsFingerprint(currentConfigs) !== configFingerprint) {
        return false
      }
      await sideEffect(transactionDb)
      return true
    })

  if (
    !(await withConfigFence((transactionDb) =>
      pruneStaleGitHubInstallations(transactionDb, installations)
    ))
  ) {
    workerLog.info(
      "github fan-out: App config changed, abandoning stale result"
    )
    return
  }
  workerLog.info(
    { count: installations.length },
    "github fan-out: enqueuing per-installation jobs"
  )

  emit(
    ctx,
    "provider.sync.started",
    {
      provider: "github",
      scope: "all",
      installationCount: installations.length,
    },
    `Found ${installations.length} GitHub installation(s) to sync`
  )

  for (const install of installations) {
    const installId = String(install.id)

    const credentialId = getGitHubInstallationDbId(installId)
    try {
      const credentialWritten = await withConfigFence(async (transactionDb) => {
        await transactionDb
          .insert(provider_credentials)
          .values({
            id: credentialId,
            provider: "github",
            credential_type: "installation",
            last_sync_status: "pending",
            last_sync_actor_user_id: ctx.requestedBy ?? null,
            last_sync_source: "system",
          })
          .onConflictDoUpdate({
            target: provider_credentials.id,
            set: {
              last_sync_status: "pending",
              last_sync_actor_user_id: ctx.requestedBy ?? null,
              last_sync_source: "system",
              updated_at: new Date(),
            },
          })
      })
      if (!credentialWritten) {
        workerLog.info(
          { credentialId },
          "github fan-out: App config changed before credential upsert"
        )
        return
      }
    } catch (err) {
      workerLog.warn(
        { err, credentialId },
        "github fan-out: upsert credential failed, skipping"
      )
      continue
    }

    if (
      !(await withConfigFence(async () => {
        await enqueueProviderReposSync({
          provider: "github",
          installationId: installId,
          ...(ctx.syncId !== undefined ? { syncId: ctx.syncId } : {}),
          ...(ctx.requestedBy !== undefined
            ? { requestedBy: ctx.requestedBy }
            : {}),
        })
      }))
    ) {
      workerLog.info(
        { installId },
        "github fan-out: App config changed before child enqueue"
      )
      return
    }
  }
}

async function syncGitHubInstallation(
  db: Db,
  installationId: string,
  ctx: SyncCtx
): Promise<void> {
  const externalInstallationId = normalizeGitHubInstallationId(installationId)
  const dbInstallationId = getGitHubInstallationDbId(externalInstallationId)

  workerLog.info(
    { installationId: externalInstallationId },
    "github sync: starting"
  )
  const startedAt = Date.now()
  const credentialId = dbInstallationId

  const claimed = await claimProviderCredential(db, credentialId)
  if (!claimed) {
    auditUnauthorized({
      jobName: "provider.repos.sync",
      jobId: `sync-${credentialId}`,
      payload: { provider: "github", installationId: externalInstallationId },
      reason: "Credential not found or already claimed by an active sync",
    })
    throw new Error(
      `GitHub credential ${credentialId} not found or already claimed by an active sync`
    )
  }

  if (!claimed.last_sync_source) {
    await db
      .update(provider_credentials)
      .set({
        last_sync_status: "failed",
        updated_at: new Date(),
      })
      .where(eq(provider_credentials.id, credentialId))
    const reason =
      "Provider credential is not claimable: missing last_sync_source"
    auditUnauthorized({
      jobName: "provider.repos.sync",
      jobId: `sync-${credentialId}`,
      payload: { provider: "github", installationId: externalInstallationId },
      reason,
    })
    throw new Error(`GitHub credential ${credentialId} is not claimable`)
  }

  auditClaimed({
    jobName: "provider.repos.sync",
    jobId: `sync-${credentialId}`,
    rowId: credentialId,
    actor: ctx.requestedBy ?? null,
    source: "api",
  })

  emit(
    ctx,
    "provider.sync.started",
    {
      provider: "github",
      scope: "installation",
      installationId: dbInstallationId,
    },
    `Importing GitHub repositories for installation ${externalInstallationId}…`
  )

  // Resolve metadata up front, but do not publish it yet. Installation
  // freshness and repositories are one snapshot and become visible together
  // only after every GitHub page has been fetched successfully.
  let liveInstallations: Awaited<ReturnType<typeof listAppInstallations>>
  try {
    const owner = await getGitHubAppConfigForInstallation(
      db,
      externalInstallationId
    )
    liveInstallations = await listAppInstallations(owner ?? undefined)
  } catch (err) {
    await db
      .update(provider_credentials)
      .set({ last_sync_status: "failed", updated_at: new Date() })
      .where(eq(provider_credentials.id, credentialId))
    emit(
      ctx,
      "provider.sync.failed",
      {
        provider: "github",
        installationId: dbInstallationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to resolve the GitHub installation"
    )
    throw err
  }
  const liveInstallation = liveInstallations.find(
    (installation) => String(installation.id) === externalInstallationId
  )
  if (!liveInstallation) {
    await db
      .update(provider_credentials)
      .set({ last_sync_status: "failed", updated_at: new Date() })
      .where(eq(provider_credentials.id, credentialId))
    throw new Error(
      `GitHub installation ${externalInstallationId} is no longer available`
    )
  }
  // An installation completed without a webhook (unreachable instance, admin
  // install) has no owning App yet; tokens cannot be issued without it.
  await bindGitHubInstallationApp(db, {
    ...buildLiveGitHubInstallationRow(liveInstallation),
    github_app_id: liveInstallation.githubAppId,
  })

  const allRepos: ProviderRepoRow[] = []
  const MAX_PAGES = 50
  let completedPagination = false
  const now = new Date()

  for (let page = 1; page <= MAX_PAGES; page++) {
    let result: {
      repos: {
        id: number | string
        fullName: string
        description: string | null
        defaultBranch: string
        private: boolean
      }[]
      hasMore: boolean
    }
    try {
      result = await ghProvider.listRepos(externalInstallationId, {
        page,
        perPage: 100,
      })
    } catch (err) {
      workerLog.warn(
        { err, installationId: externalInstallationId, page },
        "github sync: listRepos failed, stopping pagination"
      )
      emit(
        ctx,
        "provider.sync.failed",
        {
          provider: "github",
          installationId: dbInstallationId,
          page,
          error: err instanceof Error ? err.message : String(err),
        },
        `GitHub listRepos failed at page ${page}`
      )
      await db
        .update(provider_credentials)
        .set({
          last_sync_status: "failed",
          updated_at: new Date(),
        })
        .where(eq(provider_credentials.id, credentialId))
      throw err
    }

    for (const repo of result.repos) {
      allRepos.push({
        id: `github:${repo.id}`,
        installation_id: dbInstallationId,
        provider: "github",
        full_name: repo.fullName,
        name: repo.fullName.split("/").at(-1) ?? repo.fullName,
        description: repo.description ?? null,
        default_branch: repo.defaultBranch ?? null,
        private: repo.private,
        html_url: `https://github.com/${repo.fullName}`,
        pushed_at: null,
        updated_at: null,
        last_synced_at: now,
      })
    }

    emit(
      ctx,
      "provider.sync.progress",
      {
        provider: "github",
        installationId: dbInstallationId,
        page,
        reposFetched: allRepos.length,
        hasMore: result.hasMore,
      },
      `Imported ${allRepos.length} GitHub repos so far (page ${page})`
    )

    if (!result.hasMore) {
      completedPagination = true
      break
    }
  }

  if (!completedPagination) {
    await db
      .update(provider_credentials)
      .set({
        last_sync_status: "failed",
        updated_at: new Date(),
      })
      .where(eq(provider_credentials.id, credentialId))
    throw new Error(
      `GitHub repository pagination exceeded the safety limit (${MAX_PAGES} pages)`
    )
  }

  try {
    await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as Db
      await replaceInstallationSnapshot(
        transactionDb,
        buildLiveGitHubInstallationRow(liveInstallation, now),
        allRepos
      )
      await backfillLegacyGitHubInstallationGrants(
        transactionDb,
        externalInstallationId
      )
      await transactionDb
        .update(provider_credentials)
        .set({
          last_sync_status: "completed",
          updated_at: new Date(),
        })
        .where(eq(provider_credentials.id, credentialId))
    })
    workerLog.info(
      { installationId: externalInstallationId, count: allRepos.length },
      "github sync: done"
    )
    emit(
      ctx,
      "provider.sync.completed",
      {
        provider: "github",
        installationId: dbInstallationId,
        totalRepos: allRepos.length,
        durationMs: Date.now() - startedAt,
      },
      `Synced ${allRepos.length} GitHub repos`
    )
  } catch (err) {
    await db
      .update(provider_credentials)
      .set({
        last_sync_status: "failed",
        updated_at: new Date(),
      })
      .where(eq(provider_credentials.id, credentialId))
    workerLog.error(
      { err, installationId: externalInstallationId },
      "github sync: snapshot publication failed"
    )
    emit(
      ctx,
      "provider.sync.failed",
      {
        provider: "github",
        installationId: dbInstallationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to write GitHub repos to cache"
    )
    throw err
  }
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

async function syncGitLab(
  db: Db,
  userId: string | undefined,
  ctx: SyncCtx
): Promise<void> {
  if (!userId) {
    await syncGitLabFanOut(db, ctx)
    return
  }
  await syncGitLabUser(db, userId, ctx)
}

async function syncGitLabFanOut(db: Db, ctx: SyncCtx): Promise<void> {
  const rows = await db
    .select({ user_id: gitlab_tokens.user_id })
    .from(gitlab_tokens)
  workerLog.info(
    { count: rows.length },
    "gitlab fan-out: enqueuing per-user jobs"
  )
  emit(
    ctx,
    "provider.sync.started",
    { provider: "gitlab", scope: "all", installationCount: rows.length },
    `Found ${rows.length} GitLab user(s) to sync`
  )
  for (const row of rows) {
    const credentialId = `gitlab:user:${row.user_id}`
    try {
      await db
        .insert(provider_credentials)
        .values({
          id: credentialId,
          provider: "gitlab",
          credential_type: "user",
          last_sync_status: "pending",
          last_sync_actor_user_id: ctx.requestedBy ?? null,
          last_sync_source: "system",
        })
        .onConflictDoUpdate({
          target: provider_credentials.id,
          set: {
            last_sync_status: "pending",
            last_sync_actor_user_id: ctx.requestedBy ?? null,
            last_sync_source: "system",
            updated_at: new Date(),
          },
        })
    } catch (err) {
      workerLog.warn(
        { err, credentialId },
        "gitlab fan-out: upsert credential failed, skipping"
      )
      continue
    }

    await enqueueProviderReposSync({
      provider: "gitlab",
      userId: row.user_id,
      ...(ctx.syncId !== undefined ? { syncId: ctx.syncId } : {}),
      ...(ctx.requestedBy !== undefined
        ? { requestedBy: ctx.requestedBy }
        : {}),
    })
  }
}

async function syncGitLabUser(
  db: Db,
  userId: string,
  ctx: SyncCtx
): Promise<void> {
  workerLog.info({ userId }, "gitlab sync: starting")
  const startedAt = Date.now()
  const credentialId = `gitlab:user:${userId}`

  const claimed = await claimProviderCredential(db, credentialId)
  if (!claimed) {
    auditUnauthorized({
      jobName: "provider.repos.sync",
      jobId: `sync-${credentialId}`,
      payload: { provider: "gitlab", userId },
      reason: "Credential not found or already claimed by an active sync",
    })
    throw new Error(
      `GitLab credential ${credentialId} not found or already claimed by an active sync`
    )
  }

  if (!claimed.last_sync_source) {
    await db
      .update(provider_credentials)
      .set({
        last_sync_status: "failed",
        updated_at: new Date(),
      })
      .where(eq(provider_credentials.id, credentialId))
    const reason =
      "Provider credential is not claimable: missing last_sync_source"
    auditUnauthorized({
      jobName: "provider.repos.sync",
      jobId: `sync-${credentialId}`,
      payload: { provider: "gitlab", userId },
      reason,
    })
    throw new Error(`GitLab credential ${credentialId} is not claimable`)
  }

  auditClaimed({
    jobName: "provider.repos.sync",
    jobId: `sync-${credentialId}`,
    rowId: credentialId,
    actor: ctx.requestedBy ?? null,
    source: "api",
  })

  emit(
    ctx,
    "provider.sync.started",
    {
      provider: "gitlab",
      scope: "user",
      installationId: `gitlab:user:${userId}`,
    },
    `Importing GitLab projects for user ${userId}…`
  )

  let connection: Awaited<ReturnType<typeof resolveGitLabConnection>>
  try {
    connection = await resolveGitLabConnection(db, userId)
  } catch (err) {
    await db
      .update(provider_credentials)
      .set({
        last_sync_status: "failed",
        updated_at: new Date(),
      })
      .where(eq(provider_credentials.id, credentialId))
    workerLog.warn({ err, userId }, "gitlab sync: credential resolution failed")
    throw err
  }

  const provider = connection.provider
  const accessToken = connection.accessToken
  const installationId = connection.installationId
  const now = new Date()

  const installRow: ProviderInstallationInput = {
    id: installationId,
    provider: "gitlab",
    external_id: userId,
    account_login: userId,
    account_type: "User",
    repository_selection: "all",
    suspended_at: null,
    html_url: null,
    avatar_url: null,
    repository_count: null,
    last_synced_at: now,
    created_at: now,
  }

  const allRepos: ProviderRepoRow[] = []
  const MAX_PAGES = 50
  let completedPagination = false

  for (let page = 1; page <= MAX_PAGES; page++) {
    let result: {
      repos: {
        id: number | string
        fullName: string
        description: string | null
        defaultBranch: string
        private: boolean
        cloneUrl: string
      }[]
      hasMore: boolean
    }
    try {
      result = await provider.listRepos(accessToken, { page, perPage: 100 })
    } catch (err) {
      workerLog.warn(
        { err, userId, page },
        "gitlab sync: listRepos failed, stopping pagination"
      )
      emit(
        ctx,
        "provider.sync.failed",
        {
          provider: "gitlab",
          installationId,
          page,
          error: err instanceof Error ? err.message : String(err),
        },
        `GitLab listRepos failed at page ${page}`
      )
      await db
        .update(provider_credentials)
        .set({
          last_sync_status: "failed",
          updated_at: new Date(),
        })
        .where(eq(provider_credentials.id, credentialId))
      throw err
    }

    for (const repo of result.repos) {
      allRepos.push({
        id: `gitlab:${repo.id}`,
        installation_id: installationId,
        provider: "gitlab",
        full_name: repo.fullName,
        name: repo.fullName.split("/").at(-1) ?? repo.fullName,
        description: repo.description ?? null,
        default_branch: repo.defaultBranch ?? null,
        private: repo.private,
        html_url: repo.cloneUrl.replace(/\.git$/, ""),
        pushed_at: null,
        updated_at: null,
        last_synced_at: now,
      })
    }

    emit(
      ctx,
      "provider.sync.progress",
      {
        provider: "gitlab",
        installationId,
        page,
        reposFetched: allRepos.length,
        hasMore: result.hasMore,
      },
      `Imported ${allRepos.length} GitLab projects so far (page ${page})`
    )

    if (!result.hasMore) {
      completedPagination = true
      break
    }
  }

  if (!completedPagination) {
    await db
      .update(provider_credentials)
      .set({
        last_sync_status: "failed",
        updated_at: new Date(),
      })
      .where(eq(provider_credentials.id, credentialId))
    throw new Error(
      `GitLab repository pagination exceeded the safety limit (${MAX_PAGES} pages)`
    )
  }

  try {
    await replaceInstallationSnapshot(db, installRow, allRepos)
    await db
      .update(provider_credentials)
      .set({
        last_sync_status: "completed",
        updated_at: new Date(),
      })
      .where(eq(provider_credentials.id, credentialId))
    workerLog.info({ userId, count: allRepos.length }, "gitlab sync: done")
    emit(
      ctx,
      "provider.sync.completed",
      {
        provider: "gitlab",
        installationId,
        totalRepos: allRepos.length,
        durationMs: Date.now() - startedAt,
      },
      `Synced ${allRepos.length} GitLab projects`
    )
  } catch (err) {
    await db
      .update(provider_credentials)
      .set({
        last_sync_status: "failed",
        updated_at: new Date(),
      })
      .where(eq(provider_credentials.id, credentialId))
    workerLog.error({ err, userId }, "gitlab sync: snapshot publication failed")
    emit(
      ctx,
      "provider.sync.failed",
      {
        provider: "gitlab",
        installationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to write GitLab projects to cache"
    )
    throw err
  }
}
