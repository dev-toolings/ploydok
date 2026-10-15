// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import { nanoid } from "nanoid"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { z } from "zod"
import { and, eq, or } from "drizzle-orm"
import {
  discoverRepositoryTargets,
  defaultRepositoryTarget,
  ENV_FILE_PROBE_KEYS,
  MANIFEST_FILE_PROBE_KEYS,
  ManifestTooLargeError,
} from "@ploydok/shared"
import { createDb } from "@ploydok/db"
import {
  deleteGitHubAppLocalState,
  deleteGitHubInstallationUser,
  deleteGitHubInstallationUserForUser,
  assignGitHubInstallationToUser,
  getCacheStatus,
  getGitHubAppConfig,
  getInstallationStaleness,
  lockGitHubAppConfigForReset,
  listInstallations,
  listGitHubInstallationIdsForUser,
  listRepos,
  saveGitHubAppConfig,
  userOwnsGitHubInstallation,
} from "@ploydok/db/queries"
import type { ProviderRepoRow } from "@ploydok/db/queries"
import { provider_credentials, provider_installations } from "@ploydok/db"
import {
  decryptAppPrivateKey,
  decryptField,
  encryptField,
} from "../github/app-credentials"
import { buildManifest } from "../github/manifest"
import { signAppJwt } from "../github/jwt"
import { childLogger } from "../logger"
import { GitHubCache } from "../github/cache"
import { GitHubProvider } from "../github/client"
import {
  evictAllInstallationTokens,
  listAppInstallations,
  revokeAppInstallation,
} from "../github/installation-tokens"
import { GitHubAppCredentialsError } from "../github/errors"
import { handleWebhook, verifySignature } from "../github/webhook"
import { findRecentByPayloadHash } from "../webhooks/deliveries"
import { githubWebhookRateLimit } from "../webhooks/rate-limiters"
import { enqueueProviderReposSync } from "../worker/handlers/sync-provider-repos"
import { env } from "../env"
import { shouldUseSecureCookies } from "../auth/jwt"
import {
  GITHUB_RETURN_FALLBACK,
  buildReturnUrl,
  sanitizeReturnTo,
} from "./provider-return"
import type { ProviderReturnPath } from "./provider-return"
import { isAllowedNestedProviderFilePath } from "./provider-file-path"
import { isInstanceAdmin, requireInstanceAdmin } from "../auth/instance-admin"

// ---------------------------------------------------------------------------
// Singleton cache + provider (per-process)
// ---------------------------------------------------------------------------

const ghCache = new GitHubCache()
export const ghProvider = new GitHubProvider(ghCache)

const log = childLogger("github.routes")

const GITHUB_APP_CREDENTIALS_UNREADABLE_MESSAGE =
  "The stored GitHub App private key cannot be decrypted. MASTER_KEY may have changed; restore the original key or recreate the GitHub App. No GitHub installation was modified."

const ImportGitHubAppConfigBody = z.object({
  appId: z.string().trim().regex(/^\d+$/, "appId must be numeric"),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
  privateKey: z.string().min(1),
  webhookSecret: z.string().optional().default(""),
  slug: z.string().trim().min(1),
  name: z.string().trim().min(1),
})

function readFileProbeQuery(
  url: string
): { paths: string[]; ref: string } | null {
  const parsed = new URL(url)
  const ref = parsed.searchParams.get("ref")?.trim() ?? ""
  const paths = parsed.searchParams
    .getAll("path")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)

  if (!ref || paths.length === 0 || paths.length > 100) return null
  return { paths: Array.from(new Set(paths)), ref }
}

function emptyFileProbeResult(
  paths: ReadonlyArray<string>
): Record<string, boolean> {
  return Object.fromEntries(paths.map((path) => [path, false]))
}

function isAllowedEnvFilePath(path: string): boolean {
  return isAllowedNestedProviderFilePath(path, ENV_FILE_PROBE_KEYS)
}

function isAllowedManifestFilePath(path: string): boolean {
  return isAllowedNestedProviderFilePath(path, MANIFEST_FILE_PROBE_KEYS)
}

const RESET_APP_CONFIRMATION = "uninstall-github-installations"
const FORGET_LOCAL_APP_CONFIRMATION = "forget-local-github-app"

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type GithubRouterEnv = {
  Variables: { user?: import("../auth/middleware").AuthUser }
}
export const githubRouter = new Hono<GithubRouterEnv>()

// Database singleton for this router
const db = createDb(env.DATABASE_URL)
const githubAppAdmin = requireInstanceAdmin(db)

githubRouter.use("/app/manifest", githubAppAdmin)
githubRouter.use("/app/import", githubAppAdmin)
githubRouter.use("/app/config", githubAppAdmin)
githubRouter.use("/app/config/local", githubAppAdmin)
githubRouter.use("/app/credentials/status", githubAppAdmin)

async function markGitHubInstallationSyncPending(opts: {
  installationId: string
  actorUserId?: string | null
  source?: "api" | "webhook:github" | "system"
}): Promise<void> {
  const credentialId = `github:${opts.installationId}`
  await db
    .insert(provider_credentials)
    .values({
      id: credentialId,
      provider: "github",
      credential_type: "installation",
      last_sync_status: "pending",
      last_sync_actor_user_id: opts.actorUserId ?? null,
      last_sync_source: opts.source ?? "api",
      last_sync_claimed_at: null,
    })
    .onConflictDoUpdate({
      target: provider_credentials.id,
      set: {
        last_sync_status: "pending",
        last_sync_actor_user_id: opts.actorUserId ?? null,
        last_sync_source: opts.source ?? "api",
        last_sync_claimed_at: null,
        updated_at: new Date(),
      },
    })
}

function normalizeGitHubInstallationId(
  value: string | undefined
): string | null {
  if (!value) return null
  const raw = value.startsWith("github:")
    ? value.slice("github:".length)
    : value
  if (!/^\d+$/.test(raw)) return null
  return raw
}

function getGitHubInstallationDbId(installationId: string): string {
  return `github:${installationId}`
}

async function deleteGitHubInstallationLocalState(
  installationId: string
): Promise<void> {
  const externalId = normalizeGitHubInstallationId(installationId)
  if (!externalId) return
  const dbId = getGitHubInstallationDbId(externalId)

  await db.delete(provider_credentials).where(eq(provider_credentials.id, dbId))
  await db
    .delete(provider_installations)
    .where(
      and(
        eq(provider_installations.provider, "github"),
        or(
          eq(provider_installations.id, dbId),
          eq(provider_installations.external_id, externalId)
        )
      )
    )
  await deleteGitHubInstallationUser(db, externalId)
}

function normalizePem(value: string): string {
  const trimmed = value.trim()
  return trimmed.includes("\\n") && !trimmed.includes("\n")
    ? trimmed.replaceAll("\\n", "\n")
    : trimmed
}

function isSameStoredGitHubApp(
  expected: NonNullable<Awaited<ReturnType<typeof getGitHubAppConfig>>>,
  current: NonNullable<Awaited<ReturnType<typeof getGitHubAppConfig>>>
): boolean {
  const sameValue = (left: unknown, right: unknown) =>
    Buffer.isBuffer(left) && Buffer.isBuffer(right)
      ? left.equals(right)
      : left === right

  return (
    current.id === expected.id &&
    current.app_id === expected.app_id &&
    current.client_id === expected.client_id &&
    current.slug === expected.slug &&
    current.name === expected.name &&
    sameValue(current.client_secret_enc, expected.client_secret_enc) &&
    sameValue(current.client_secret_nonce, expected.client_secret_nonce) &&
    sameValue(current.pem_enc, expected.pem_enc) &&
    sameValue(current.pem_nonce, expected.pem_nonce) &&
    sameValue(current.webhook_secret_enc, expected.webhook_secret_enc) &&
    sameValue(current.webhook_secret_nonce, expected.webhook_secret_nonce)
  )
}

// ---------------------------------------------------------------------------
// App-manifest state cookie helpers
// ---------------------------------------------------------------------------

const APP_STATE_COOKIE = "gh_app_state"
const INSTALL_STATE_COOKIE = "gh_install_state"
const APP_STATE_TTL_SECONDS = 10 * 60 // 10 minutes

/** Constant-time check that `payload` is the MAC-protected prefix of the cookie. */
function verifySignedPrefix(cookieValue: string): string | null {
  const lastDot = cookieValue.lastIndexOf(".")
  if (lastDot === -1) return null
  const payload = cookieValue.slice(0, lastDot)
  const mac = cookieValue.slice(lastDot + 1)
  const expected = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("hex")
  const expBuf = Buffer.from(expected, "hex")
  const gotBuf = Buffer.from(mac, "hex")
  if (expBuf.length !== gotBuf.length) return null
  let diff = 0
  for (let i = 0; i < expBuf.length; i++) diff |= expBuf[i]! ^ gotBuf[i]!
  return diff === 0 ? payload : null
}

function signAppState(
  state: string,
  returnTo: ProviderReturnPath = GITHUB_RETURN_FALLBACK
): string {
  const payload = Buffer.from(JSON.stringify({ state, returnTo })).toString(
    "base64url"
  )
  const mac = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("hex")
  return `${payload}.${mac}`
}

/**
 * Accepts both the JSON payload format and the legacy bare-state format still
 * held by cookies minted before this shipped. The MAC covers everything before
 * the last dot in either case, so the two branches cannot be confused: a legacy
 * state is a randomUUID, never valid base64url JSON.
 */
function verifyAppState(
  cookieValue: string,
  state: string
): { returnTo: ProviderReturnPath | null } | null {
  const payload = verifySignedPrefix(cookieValue)
  if (payload === null) return null
  if (payload === state) return { returnTo: null }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      state?: unknown
      returnTo?: unknown
    }
    if (parsed.state !== state) return null
    return {
      returnTo: sanitizeReturnTo(parsed.returnTo, GITHUB_RETURN_FALLBACK),
    }
  } catch {
    return null
  }
}

function signInstallState(
  state: string,
  userId: string,
  returnTo: ProviderReturnPath = GITHUB_RETURN_FALLBACK
): string {
  const payload = Buffer.from(
    JSON.stringify({ state, userId, returnTo })
  ).toString("base64url")
  const mac = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("hex")
  return `${payload}.${mac}`
}

function verifyInstallState(
  cookieValue: string,
  state: string
): { userId: string; returnTo: ProviderReturnPath } | null {
  const payload = verifySignedPrefix(cookieValue)
  if (payload === null) return null

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      state?: unknown
      userId?: unknown
      returnTo?: unknown
    }
    if (parsed.state !== state || typeof parsed.userId !== "string") return null
    return {
      userId: parsed.userId,
      returnTo: sanitizeReturnTo(parsed.returnTo, GITHUB_RETURN_FALLBACK),
    }
  } catch {
    return null
  }
}

function buildCookieStr(
  name: string,
  value: string,
  maxAge: number,
  httpOnly: boolean
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
  ]
  if (httpOnly) parts.push("HttpOnly")
  if (shouldUseSecureCookies()) parts.push("Secure")
  return parts.join("; ")
}

function clearCookieStr(name: string): string {
  const parts = [`${name}=`, "Path=/", "Max-Age=0", "SameSite=Lax"]
  if (shouldUseSecureCookies()) parts.push("Secure")
  return parts.join("; ")
}

function parseCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=")
    if (eqIdx === -1) continue
    const k = part.slice(0, eqIdx).trim()
    const v = part.slice(eqIdx + 1).trim()
    if (k === name) return decodeURIComponent(v)
  }
  return null
}

function buildInstallStartUrl(slug: string, state: string): string {
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`
}

function getApiOrigin(): string {
  return new URL(env.GITHUB_APP_CALLBACK_URL).origin
}

function getUserId(c: {
  get: (key: "user") => GithubRouterEnv["Variables"]["user"]
}): string | null {
  return c.get("user")?.id ?? null
}

async function getUserGitHubInstallationIds(userId: string): Promise<string[]> {
  return listGitHubInstallationIdsForUser(db, userId)
}

async function getAccessibleGitHubInstallationIds(
  userId: string
): Promise<string[]> {
  if (!(await isInstanceAdmin(db, userId))) {
    return getUserGitHubInstallationIds(userId)
  }
  const installations = await listAppInstallations()
  return installations.map((installation) => String(installation.id))
}

async function listUserGitHubInstallations(userId: string) {
  const allowedIds = new Set(await getUserGitHubInstallationIds(userId))
  if (allowedIds.size === 0) return []
  // A GitHub outage and a revoked installation both end up as an empty list
  // here. Callers cannot tell them apart, so at least leave a trace.
  const installations = await listAppInstallations().catch((err: unknown) => {
    log.warn(
      { err, userId },
      "listAppInstallations failed; treating the user as having no installation"
    )
    return []
  })
  return installations.filter((installation) =>
    allowedIds.has(String(installation.id))
  )
}

function preferredInstallations(
  installations: Awaited<ReturnType<typeof listAppInstallations>>,
  owner: string
) {
  const match = installations.find(
    (installation) =>
      installation.accountLogin.toLowerCase() === owner.toLowerCase()
  )
  return match ? [match] : installations
}

// ---------------------------------------------------------------------------
// DB → wire format helpers
// ---------------------------------------------------------------------------

function dbRowToWire(row: ProviderRepoRow) {
  const installationId = normalizeGitHubInstallationId(row.installation_id)
  return {
    id: row.id,
    fullName: row.full_name,
    description: row.description ?? null,
    private: row.private,
    ...(installationId ? { installationId } : {}),
    defaultBranch: row.default_branch ?? "main",
    cloneUrl: row.html_url
      ? row.html_url.replace(/\/?$/, ".git")
      : `https://github.com/${row.full_name}.git`,
  }
}

// ---------------------------------------------------------------------------
// GET /github/repos?page=1&per_page=30&search=  (auth required)
// ---------------------------------------------------------------------------

githubRouter.get("/repos", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  const page = Math.max(1, Number(c.req.query("page") ?? 1))
  const perPage = Math.min(
    100,
    Math.max(1, Number(c.req.query("per_page") ?? 30))
  )
  const search = c.req.query("search") ?? undefined

  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  const installUrl = `${getApiOrigin()}/github/installations/start`
  const installationIds = await getUserGitHubInstallationIds(userId)
  const installationDbIds = installationIds.map(getGitHubInstallationDbId)
  if (installationIds.length === 0) {
    return c.json({
      repos: [],
      page,
      perPage,
      hasMore: false,
      needsInstall: true,
      installUrl,
    })
  }

  const dbInstallations = await listInstallations(
    db,
    "github",
    installationDbIds
  )

  if (dbInstallations.length === 0) {
    // Fire a background sync so the cache is populated for the next request.
    void Promise.all(
      installationIds.map((installationId) =>
        enqueueProviderReposSync({
          provider: "github",
          installationId,
          requestedBy: userId,
        })
      )
    ).catch((err) => log.warn({ err }, "enqueue on empty installations failed"))

    // Try a live fetch with a 3s timeout so first-time users don't see an empty list.
    let liveInstallations: Awaited<ReturnType<typeof listAppInstallations>> = []
    try {
      liveInstallations = await Promise.race([
        listUserGitHubInstallations(userId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 3000)
        ),
      ])
    } catch {
      // Timeout or API error — fall through to empty response.
    }

    if (liveInstallations.length === 0) {
      return c.json({
        repos: [],
        page,
        perPage,
        hasMore: false,
        needsInstall: true,
        installUrl,
      })
    }
  }

  // Stale-while-revalidate: if the most stale installation was synced >10 min ago, enqueue.
  const staleness = await getInstallationStaleness(
    db,
    "github",
    installationDbIds
  )
  if (
    staleness.mostStaleAt &&
    Date.now() - staleness.mostStaleAt.getTime() > 10 * 60_000
  ) {
    void Promise.all(
      installationIds.map((installationId) =>
        enqueueProviderReposSync({
          provider: "github",
          installationId,
          requestedBy: userId,
        })
      )
    ).catch((err) => log.warn({ err }, "stale-while-revalidate enqueue failed"))
  }

  // Fast path: exact "owner/repo" match → try DB first, then live API fallback.
  if (search && search.includes("/")) {
    const dbExact = await listRepos(db, {
      provider: "github",
      search, // narrowed to string by the if-guard above
      installationIds: installationDbIds,
      limit: 1,
      offset: 0,
    })

    const exactRow = dbExact.rows.find(
      (r) => r.full_name.toLowerCase() === search.toLowerCase()
    )

    if (exactRow) {
      return c.json({
        repos: [dbRowToWire(exactRow)],
        page: 1,
        perPage,
        hasMore: false,
        installUrl,
      })
    }

    // DB miss — try live API per installation.
    const liveInstallations = await listUserGitHubInstallations(userId)
    for (const inst of liveInstallations) {
      try {
        const repo = await ghProvider.getRepo(String(inst.id), search)
        return c.json({
          repos: [{ ...repo, installationId: String(inst.id) }],
          page: 1,
          perPage,
          hasMore: false,
          installUrl,
        })
      } catch {
        // not found on this installation, try the next one
      }
    }
    // fall through to paginated DB scan
  }

  const offset = (page - 1) * perPage
  const { rows, total } = await listRepos(db, {
    provider: "github",
    ...(search !== undefined ? { search } : {}),
    installationIds: installationDbIds,
    limit: perPage,
    offset,
  })

  return c.json({
    repos: rows.map(dbRowToWire),
    page,
    perPage,
    hasMore: total > offset + rows.length,
    installUrl,
  })
})

// ---------------------------------------------------------------------------
// POST /github/installations/sync  (auth required)
// Force a full refresh of the repo cache for one or all installations.
// ---------------------------------------------------------------------------

githubRouter.post("/installations/sync", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)
  let body: { installationId?: string } = {}
  try {
    const raw = await c.req.json().catch(() => ({}))
    if (raw && typeof raw === "object")
      body = raw as { installationId?: string }
  } catch {
    // body is optional — ignore parse errors
  }

  const installationId =
    typeof body.installationId === "string"
      ? normalizeGitHubInstallationId(body.installationId)
      : undefined
  if (installationId === null) {
    return c.json({ error: "invalid_installation_id" }, 400)
  }
  let allowedIds: string[]
  try {
    allowedIds = await getAccessibleGitHubInstallationIds(user.id)
  } catch (err) {
    log.error({ err, userId: user.id }, "failed to resolve GitHub sync scope")
    return c.json({ error: "github_api_error", detail: String(err) }, 502)
  }
  if (installationId && !allowedIds.includes(installationId)) {
    return c.json({ error: "github_installation_not_found" }, 404)
  }
  const targetIds = installationId ? [installationId] : allowedIds
  if (targetIds.length === 0) {
    return c.json({ error: "GIT_PROVIDER_NOT_CONNECTED" }, 412)
  }
  const syncId = nanoid()

  for (const targetId of targetIds) {
    await markGitHubInstallationSyncPending({
      installationId: targetId,
      actorUserId: user.id,
      source: "api",
    })
    await enqueueProviderReposSync({
      provider: "github",
      installationId: targetId,
      requestedBy: user.id,
      syncId,
    })
  }

  log.info(
    { installationIds: targetIds, syncId, requestedBy: user.id },
    "manual github sync enqueued"
  )
  return c.json({ enqueued: true, syncId, installationIds: targetIds }, 202)
})

// ---------------------------------------------------------------------------
// GET /github/installations/cache-status  (auth required)
// Returns cache status for every live installation to instance admins, and
// only user-linked installations to members.
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 10 * 60 * 1000

githubRouter.get("/installations/cache-status", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  let installationIds: string[]
  try {
    installationIds = await getAccessibleGitHubInstallationIds(userId)
  } catch (err) {
    log.error({ err, userId }, "failed to resolve GitHub cache-status scope")
    return c.json({ error: "github_api_error", detail: String(err) }, 502)
  }
  const rows = await getCacheStatus(
    db,
    "github",
    installationIds.map(getGitHubInstallationDbId)
  )
  const now = Date.now()
  return c.json({
    installations: rows.map((r) => ({
      id: r.id,
      externalId: r.externalId,
      accountLogin: r.accountLogin,
      avatarUrl: r.avatarUrl,
      htmlUrl: r.htmlUrl,
      lastSyncedAt: r.lastSyncedAt.toISOString(),
      repoCount: r.repoCount,
      ageMs: now - r.lastSyncedAt.getTime(),
      status:
        now - r.lastSyncedAt.getTime() > STALE_THRESHOLD_MS ? "stale" : "fresh",
    })),
    staleThresholdMs: STALE_THRESHOLD_MS,
  })
})

// ---------------------------------------------------------------------------
// GET /github/repos/:owner/:repo/branches  (auth required)
// ---------------------------------------------------------------------------

githubRouter.get("/repos/:owner/:repo/branches", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  const owner = c.req.param("owner")
  const repo = c.req.param("repo")
  const fullName = `${owner}/${repo}`

  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  const installations = await listUserGitHubInstallations(userId)
  if (installations.length === 0) {
    // The repo picker is served from the cached repo table, so it stays
    // populated after an installation is revoked on GitHub. Without this flag
    // the wizard would report "no branches" for a repo that simply is not
    // reachable any more.
    return c.json({
      branches: [],
      needsInstall: true,
      installUrl: `${getApiOrigin()}/github/installations/start`,
    })
  }

  // Prefer the installation whose account matches the repo owner.
  const candidates = preferredInstallations(installations, owner)

  for (const inst of candidates) {
    try {
      const branches = await ghProvider.listBranches(String(inst.id), fullName)
      return c.json({ branches })
    } catch (err) {
      log.warn(
        { err, installationId: inst.id, fullName },
        "listBranches failed; trying next"
      )
    }
  }

  return c.json({ error: "repo_not_accessible", detail: fullName }, 404)
})

// ---------------------------------------------------------------------------
// GET /github/repos/:owner/:repo/file-exists?path=&ref=  (auth required)
// Probes whether a file exists at the given path on the given branch.
// Used by the create-app wizard to auto-detect a Dockerfile.
// ---------------------------------------------------------------------------

githubRouter.get("/repos/:owner/:repo/file-exists", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  const owner = c.req.param("owner")
  const repo = c.req.param("repo")
  const fullName = `${owner}/${repo}`
  const filePath = c.req.query("path")
  const ref = c.req.query("ref")

  if (!filePath || !ref) {
    return c.json({ error: "missing_path_or_ref" }, 400)
  }

  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  const installations = await listUserGitHubInstallations(userId)
  if (installations.length === 0) {
    return c.json({ exists: false })
  }

  const candidates = preferredInstallations(installations, owner)

  for (const inst of candidates) {
    try {
      const exists = await ghProvider.fileExists(
        String(inst.id),
        fullName,
        filePath,
        ref
      )
      return c.json({ exists })
    } catch (err) {
      log.warn(
        { err, installationId: inst.id, fullName, filePath },
        "fileExists failed; trying next"
      )
    }
  }

  return c.json({ error: "repo_not_accessible", detail: fullName }, 404)
})

// ---------------------------------------------------------------------------
// GET /github/repos/:owner/:repo/files-exist?path=&path=&ref=  (auth required)
// Batch variant used by the create-app wizard stack classifier.
// ---------------------------------------------------------------------------

githubRouter.get("/repos/:owner/:repo/files-exist", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  const owner = c.req.param("owner")
  const repo = c.req.param("repo")
  const fullName = `${owner}/${repo}`
  const query = readFileProbeQuery(c.req.url)

  if (!query) {
    return c.json({ error: "missing_or_invalid_paths_or_ref" }, 400)
  }

  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  const installations = await listUserGitHubInstallations(userId)
  if (installations.length === 0) {
    return c.json({ files: emptyFileProbeResult(query.paths) })
  }

  const candidates = preferredInstallations(installations, owner)

  for (const inst of candidates) {
    try {
      const entries = await Promise.all(
        query.paths.map(
          async (filePath) =>
            [
              filePath,
              await ghProvider.fileExists(
                String(inst.id),
                fullName,
                filePath,
                query.ref
              ),
            ] as const
        )
      )
      return c.json({ files: Object.fromEntries(entries) })
    } catch (err) {
      log.warn(
        { err, installationId: inst.id, fullName },
        "filesExist failed; trying next"
      )
    }
  }

  return c.json({ error: "repo_not_accessible", detail: fullName }, 404)
})

// Uses the same installation visibility as file probes; returns classifications only.
githubRouter.get("/repos/:owner/:repo/deployment-targets", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  const ref = c.req.query("ref")?.trim()
  if (!ref) return c.json({ error: "missing_ref" }, 400)
  const owner = c.req.param("owner")
  const fullName = `${owner}/${c.req.param("repo")}`
  if (!(await getGitHubAppConfig(db)))
    return c.json({ error: "github_app_not_configured" }, 503)
  const installations = preferredInstallations(
    await listUserGitHubInstallations(userId),
    owner
  )
  for (const inst of installations) {
    try {
      const id = String(inst.id)
      const paths = await ghProvider.listFiles(id, fullName, ref)
      const targets = await discoverRepositoryTargets(paths, (path) =>
        ghProvider.readFile(id, fullName, path, ref)
      )
      const defaultTarget = defaultRepositoryTarget(targets)
      return c.json({
        targets,
        ambiguous:
          targets.some((target) => target.classification.ambiguous === true) ||
          (defaultTarget === undefined && targets.length > 1),
        defaultRootDir: defaultTarget?.rootDir ?? null,
      })
    } catch (err) {
      log.warn({ err, fullName }, "repository target detection failed")
    }
  }
  return c.json({ error: "repository_detection_unavailable" }, 502)
})

githubRouter.get("/repos/:owner/:repo/env-file", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  const owner = c.req.param("owner")
  const repo = c.req.param("repo")
  const fullName = `${owner}/${repo}`
  const filePath = c.req.query("path")?.trim() ?? ""
  const ref = c.req.query("ref")?.trim() ?? ""

  if (!filePath || !ref || !isAllowedEnvFilePath(filePath)) {
    return c.json({ error: "missing_or_invalid_path_or_ref" }, 400)
  }

  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  const installations = await listUserGitHubInstallations(userId)
  const candidates = preferredInstallations(installations, owner)

  for (const inst of candidates) {
    try {
      const content = await ghProvider.readFile(
        String(inst.id),
        fullName,
        filePath,
        ref
      )
      return c.json({ path: filePath, content })
    } catch (err) {
      log.warn(
        { err, installationId: inst.id, fullName, filePath },
        "envFile read failed; trying next"
      )
    }
  }

  return c.json({ error: "repo_not_accessible", detail: fullName }, 404)
})

githubRouter.get("/repos/:owner/:repo/manifest-file", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  const owner = c.req.param("owner")
  const repo = c.req.param("repo")
  const fullName = `${owner}/${repo}`
  const filePath = c.req.query("path")?.trim() ?? ""
  const ref = c.req.query("ref")?.trim() ?? ""

  if (!filePath || !ref || !isAllowedManifestFilePath(filePath)) {
    return c.json({ error: "missing_or_invalid_path_or_ref" }, 400)
  }

  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  const installations = await listUserGitHubInstallations(userId)
  const candidates = preferredInstallations(installations, owner)

  for (const inst of candidates) {
    try {
      const content = await ghProvider.readFile(
        String(inst.id),
        fullName,
        filePath,
        ref
      )
      return c.json({ path: filePath, content })
    } catch (err) {
      if (err instanceof ManifestTooLargeError) {
        return c.json({ error: "MANIFEST_TOO_LARGE", detail: filePath }, 413)
      }
      log.warn(
        { err, installationId: inst.id, fullName, filePath },
        "manifestFile read failed; trying next"
      )
    }
  }

  return c.json({ error: "repo_not_accessible", detail: fullName }, 404)
})

// ---------------------------------------------------------------------------
// GET /github/installations  (auth required)
// Instance admins see every live GitHub App installation. Members see only
// installations explicitly linked to their user mapping.
// ---------------------------------------------------------------------------

githubRouter.get("/installations", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  try {
    const installations = (await isInstanceAdmin(db, userId))
      ? await listAppInstallations()
      : await listUserGitHubInstallations(userId)
    // Enrich each with a repository count (best-effort; skip on error).
    const enriched = await Promise.all(
      installations.map(async (inst) => {
        try {
          const { repos } = await ghProvider.listRepos(String(inst.id), {
            page: 1,
            perPage: 100,
          })
          return { ...inst, repositoryCount: repos.length }
        } catch {
          return { ...inst, repositoryCount: null as number | null }
        }
      })
    )
    return c.json({
      installations: enriched,
      installUrl: `${getApiOrigin()}/github/installations/start`,
    })
  } catch (err) {
    log.error({ err }, "listAppInstallations failed")
    return c.json({ error: "github_api_error", detail: String(err) }, 502)
  }
})

// ---------------------------------------------------------------------------
// GET /github/installations/start  (instance admin required)
// Only an instance admin may start adding/updating a global App installation.
// The signed state binds that admin for revalidation in the public callback.
// ---------------------------------------------------------------------------

githubRouter.get("/installations/start", async (c) => {
  const user = c.get("user")
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401)
  }
  if (!(await isInstanceAdmin(db, user.id))) {
    return c.json({ error: "admin_required" }, 403)
  }
  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  const returnTo = sanitizeReturnTo(
    c.req.query("return_to"),
    GITHUB_RETURN_FALLBACK
  )
  const state = crypto.randomUUID()
  c.header(
    "Set-Cookie",
    buildCookieStr(
      INSTALL_STATE_COOKIE,
      signInstallState(state, user.id, returnTo),
      APP_STATE_TTL_SECONDS,
      true
    )
  )
  return c.redirect(buildInstallStartUrl(config.slug, state), 302)
})

// Rebuilds the local user links after a database or encryption-key reset.
// GitHub's App API is the source of truth here: only installations currently
// returned for this exact App are linked, and only an instance admin may run
// the reconciliation.
githubRouter.post("/installations/reconnect", async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "unauthenticated" }, 401)
  if (!(await isInstanceAdmin(db, user.id))) {
    return c.json({ error: "admin_required" }, 403)
  }
  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  try {
    const installations = await listAppInstallations()
    if (installations.length === 0) {
      return c.json(
        {
          error: "github_installation_not_found",
          message: "This GitHub App is not installed on any account.",
        },
        404
      )
    }

    const syncIds: string[] = []
    for (const installation of installations) {
      const installationId = String(installation.id)
      const syncId = nanoid()
      await markGitHubInstallationSyncPending({
        installationId,
        actorUserId: user.id,
        source: "api",
      })
      await assignGitHubInstallationToUser(db, installationId, user.id)
      await enqueueProviderReposSync({
        provider: "github",
        installationId,
        requestedBy: user.id,
        syncId,
      })
      syncIds.push(syncId)
    }

    return c.json({
      connected: true,
      installation_count: installations.length,
      sync_ids: syncIds,
    })
  } catch (err) {
    log.error({ err, userId: user.id }, "github installation reconnect failed")
    return c.json(
      {
        error: "github_api_error",
        message: "Unable to verify the existing GitHub App installation.",
      },
      502
    )
  }
})

// ---------------------------------------------------------------------------
// DELETE /github/installations/:id  (auth required)
// Members disconnect only their own local mapping. Instance admins revoke the
// GitHub installation globally and remove its local state.
// ---------------------------------------------------------------------------

githubRouter.delete("/installations/:id", async (c) => {
  const idParam = c.req.param("id")
  const installationId = Number(idParam)
  if (!Number.isFinite(installationId) || installationId <= 0) {
    return c.json({ error: "invalid_installation_id" }, 400)
  }
  const user = c.get("user")
  if (!user) return c.json({ error: "unauthenticated" }, 401)
  const externalInstallationId = String(installationId)
  const admin = await isInstanceAdmin(db, user.id)

  if (!admin) {
    if (
      !(await userOwnsGitHubInstallation(db, user.id, externalInstallationId))
    ) {
      return c.json({ error: "github_installation_not_found" }, 404)
    }
    await deleteGitHubInstallationUserForUser(
      db,
      externalInstallationId,
      user.id
    )
    return c.json({ ok: true, disconnected: installationId })
  }

  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  try {
    await revokeAppInstallation(installationId)
    await deleteGitHubInstallationLocalState(externalInstallationId)
    return c.json({ ok: true, revoked: installationId })
  } catch (err) {
    log.error({ err, installationId }, "revokeAppInstallation failed")
    return c.json({ error: "github_api_error", detail: String(err) }, 502)
  }
})

// ---------------------------------------------------------------------------
// GET /github/app/setup  (public GitHub redirect; signed admin state required)
// ---------------------------------------------------------------------------
// GitHub appends `?installation_id=X&setup_action=install|update` when a user
// finishes installing (or updating) the App. Before any mapping, credential
// write, or enqueue, the callback verifies that the user bound into the signed
// state is still an instance admin. Never trust `installation_id` alone.
// ---------------------------------------------------------------------------

githubRouter.get("/app/setup", async (c) => {
  const installationId = c.req.query("installation_id")
  const setupAction = c.req.query("setup_action")
  const state = c.req.query("state")
  const params = new URLSearchParams()
  if (installationId) params.set("installation_id", installationId)
  if (setupAction) params.set("setup_action", setupAction)
  const cookieHeader = c.req.raw.headers.get("cookie") ?? ""
  const rawInstallStateCookie = parseCookie(cookieHeader, INSTALL_STATE_COOKIE)
  const installState =
    state && rawInstallStateCookie
      ? verifyInstallState(rawInstallStateCookie, state)
      : null
  const requestedBy = installState?.userId ?? null
  const legacyState =
    !installState && state && rawInstallStateCookie
      ? verifyAppState(rawInstallStateCookie, state)
      : null
  const stateValid = !!installState || !!legacyState
  // Only ever read from the MAC-verified payload, never from the query string.
  const returnTo =
    installState?.returnTo ?? legacyState?.returnTo ?? GITHUB_RETURN_FALLBACK

  c.header("Set-Cookie", clearCookieStr(INSTALL_STATE_COOKIE))
  if (stateValid) {
    const requestedByIsAdmin = requestedBy
      ? await isInstanceAdmin(db, requestedBy)
      : false
    if (!requestedByIsAdmin) {
      params.set("install_error", "admin_required")
    } else {
      const actorUserId = requestedBy as string
      const normalizedInstallationId =
        normalizeGitHubInstallationId(installationId)
      if (!normalizedInstallationId) {
        params.set("install_error", "missing_installation_id")
      } else {
        const syncId = nanoid()
        try {
          await markGitHubInstallationSyncPending({
            installationId: normalizedInstallationId,
            actorUserId,
            source: "api",
          })
          await assignGitHubInstallationToUser(
            db,
            normalizedInstallationId,
            actorUserId
          )
          await enqueueProviderReposSync({
            provider: "github",
            installationId: normalizedInstallationId,
            requestedBy: actorUserId,
            syncId,
          })
          params.set("installed", "1")
          params.set("sync_id", syncId)
        } catch (err) {
          log.error(
            { err, installationId: normalizedInstallationId, syncId },
            "github setup callback sync enqueue failed"
          )
          params.set("install_error", "sync_failed")
        }
      }
    }
  } else if (state || rawInstallStateCookie) {
    params.set("install_error", "state_mismatch")
  }
  return c.redirect(
    buildReturnUrl(sanitizeReturnTo(returnTo, GITHUB_RETURN_FALLBACK), params),
    302
  )
})

// [S4.2.A App flow — BEGIN]

// ---------------------------------------------------------------------------
// POST /github/app/manifest  (auth required — wired in app.ts)
// ---------------------------------------------------------------------------

githubRouter.post("/app/manifest", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    return_to?: unknown
  } | null
  const returnTo = sanitizeReturnTo(body?.return_to, GITHUB_RETURN_FALLBACK)
  const state = crypto.randomUUID()

  // Build self URL (scheme + host from request or env fallback)
  const selfUrl = env.GITHUB_APP_CALLBACK_URL
    ? new URL(env.GITHUB_APP_CALLBACK_URL).origin
    : `http://localhost:${env.PORT}`

  const manifest = buildManifest({
    webBaseUrl: env.WEB_ORIGIN,
    apiBaseUrl: selfUrl,
  })

  // Store HMAC-signed state in httpOnly cookie (10 min)
  c.header(
    "Set-Cookie",
    buildCookieStr(
      APP_STATE_COOKIE,
      signAppState(state, returnTo),
      APP_STATE_TTL_SECONDS,
      true
    )
  )

  return c.json({
    manifest,
    state,
    post_url: `https://github.com/settings/apps/new?state=${state}`,
  })
})

// ---------------------------------------------------------------------------
// POST /github/app/import  (auth required)
// Reconnects a GitHub App that already exists on github.com after a local DB
// reset. The installation may already exist; this endpoint restores the App
// credentials needed to sign JWTs, then kicks a global sync.
// ---------------------------------------------------------------------------

githubRouter.post("/app/import", async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = ImportGitHubAppConfigBody.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_body",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    )
  }

  const privateKey = normalizePem(parsed.data.privateKey)
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    return c.json(
      {
        error: "invalid_private_key",
        message: "privateKey must be a PEM private key.",
      },
      400
    )
  }

  const currentConfig = await getGitHubAppConfig(db)
  if (currentConfig && currentConfig.app_id !== parsed.data.appId) {
    return c.json(
      {
        error: "github_app_mismatch",
        message:
          "Reconnect the currently configured GitHub App using its original App ID.",
      },
      409
    )
  }

  let jwt: string
  try {
    jwt = signAppJwt(privateKey, parsed.data.appId)
  } catch {
    return c.json(
      {
        error: "invalid_private_key",
        message: "The private key must be a valid RSA PEM key.",
      },
      400
    )
  }

  let verifiedApp: { id: number; client_id: string; slug: string; name: string }
  try {
    const response = await fetch("https://api.github.com/app", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "ploydok",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      return c.json(
        {
          error: "github_app_credentials_invalid",
          message:
            "GitHub rejected the App ID or private key. The existing configuration was preserved.",
        },
        422
      )
    }
    if (!response.ok)
      throw new Error(`GitHub App verification returned ${response.status}`)
    verifiedApp = z
      .object({
        id: z.number().int().positive(),
        client_id: z.string().min(1),
        slug: z.string().min(1),
        name: z.string().min(1),
      })
      .parse(await response.json())
  } catch {
    return c.json(
      {
        error: "github_app_verification_failed",
        message:
          "Unable to verify the App with GitHub. The existing configuration was preserved. Retry later.",
      },
      502
    )
  }
  if (
    String(verifiedApp.id) !== parsed.data.appId ||
    verifiedApp.client_id !== parsed.data.clientId
  ) {
    return c.json(
      {
        error: "github_app_mismatch",
        message: "The App ID and Client ID must belong to the same GitHub App.",
      },
      422
    )
  }

  const [clientSecretResult, pemResult, webhookSecretResult] =
    await Promise.all([
      encryptField(parsed.data.clientSecret),
      encryptField(privateKey),
      encryptField(parsed.data.webhookSecret ?? ""),
    ])

  await saveGitHubAppConfig(db, {
    app_id: parsed.data.appId,
    client_id: parsed.data.clientId,
    slug: verifiedApp.slug,
    name: verifiedApp.name,
    client_secret_enc: clientSecretResult.enc,
    client_secret_nonce: clientSecretResult.nonce,
    pem_enc: pemResult.enc,
    pem_nonce: pemResult.nonce,
    webhook_secret_enc: webhookSecretResult.enc,
    webhook_secret_nonce: webhookSecretResult.nonce,
  })

  const syncId = nanoid()
  evictAllInstallationTokens()
  ghCache.invalidate()
  const requestedBy = c.get("user")?.id
  try {
    await enqueueProviderReposSync({
      provider: "github",
      syncId,
      ...(requestedBy ? { requestedBy } : {}),
    })
  } catch (err) {
    log.warn({ err, syncId }, "github app import sync enqueue failed")
    return c.json(
      {
        error: "github_app_sync_failed",
        message:
          "The credentials were saved, but repository synchronization could not start. Retry the reconnection.",
      },
      503
    )
  }

  return c.json({
    configured: true,
    name: verifiedApp.name,
    slug: verifiedApp.slug,
    app_id: parsed.data.appId,
    install_url: `${getApiOrigin()}/github/installations/start`,
  })
})

// ---------------------------------------------------------------------------
// GET /github/app/callback?code=&state=  (public — GitHub redirects here)
// ---------------------------------------------------------------------------

githubRouter.get("/app/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state")

  if (!code || !state) {
    return c.json({ error: "missing_code_or_state" }, 400)
  }

  // Verify CSRF state cookie
  const cookieHeader = c.req.raw.headers.get("cookie") ?? ""
  const rawStateCookie = parseCookie(cookieHeader, APP_STATE_COOKIE)
  if (!rawStateCookie) {
    return c.json({ error: "missing_app_state_cookie" }, 400)
  }

  // parseCookie already decoded the value; decoding twice throws URIError on a
  // stray percent sign.
  const appState = verifyAppState(rawStateCookie, state)
  if (!appState) {
    return c.json({ error: "state_mismatch" }, 400)
  }
  const returnTo = sanitizeReturnTo(appState.returnTo, GITHUB_RETURN_FALLBACK)

  // Clear state cookie
  c.header("Set-Cookie", clearCookieStr(APP_STATE_COOKIE))

  // Exchange code → GitHub App credentials (no auth required)
  const ghRes = await fetch(
    `https://api.github.com/app-manifests/${code}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ploydok",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  )

  if (!ghRes.ok) {
    const body = await ghRes.text().catch(() => "")
    return c.json({ error: "github_conversion_failed", detail: body }, 502)
  }

  const data = (await ghRes.json()) as {
    id: number
    slug: string
    name: string
    client_id: string
    client_secret: string | null
    pem: string | null
    // GitHub omits webhook_secret when the manifest has no hook_attributes
    // (loopback dev mode). Treat missing secrets as empty strings — the
    // webhook handler refuses requests when the decrypted secret is empty.
    webhook_secret: string | null
  }

  const [clientSecretResult, pemResult, webhookSecretResult] =
    await Promise.all([
      encryptField(data.client_secret ?? ""),
      encryptField(data.pem ?? ""),
      encryptField(data.webhook_secret ?? ""),
    ])

  await saveGitHubAppConfig(db, {
    app_id: String(data.id),
    client_id: data.client_id,
    slug: data.slug,
    name: data.name,
    client_secret_enc: clientSecretResult.enc,
    client_secret_nonce: clientSecretResult.nonce,
    pem_enc: pemResult.enc,
    pem_nonce: pemResult.nonce,
    webhook_secret_enc: webhookSecretResult.enc,
    webhook_secret_nonce: webhookSecretResult.nonce,
  })

  const syncId = nanoid()
  void enqueueProviderReposSync({ provider: "github", syncId }).catch((err) =>
    log.warn(
      { err, syncId },
      "github app config post-create sync enqueue failed"
    )
  )

  return c.redirect(
    buildReturnUrl(returnTo, new URLSearchParams({ app: "created" })),
    302
  )
})

// ---------------------------------------------------------------------------
// GET /github/app/config  (auth required)
// ---------------------------------------------------------------------------

githubRouter.get("/app/config", async (c) => {
  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ configured: false })
  }
  return c.json({
    configured: true,
    name: config.name,
    slug: config.slug,
    app_id: config.app_id,
    install_url: `${getApiOrigin()}/github/installations/start`,
  })
})

// ---------------------------------------------------------------------------
// GET /github/app/credentials/status  (instance admin only)
// ---------------------------------------------------------------------------

githubRouter.get("/app/credentials/status", async (c) => {
  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ status: "not_configured" as const })
  }

  try {
    await decryptAppPrivateKey(config)
    return c.json({ status: "readable" as const })
  } catch (err) {
    if (!(err instanceof GitHubAppCredentialsError)) {
      throw err
    }

    log.warn({ err }, "github app credentials check failed")
    return c.json({
      status: "unreadable" as const,
      error: {
        code: "GITHUB_APP_CREDENTIALS_UNREADABLE" as const,
        message: GITHUB_APP_CREDENTIALS_UNREADABLE_MESSAGE,
      },
    })
  }
})

// ---------------------------------------------------------------------------
// DELETE /github/app/config/local  (instance admin only — local recovery)
// ---------------------------------------------------------------------------

githubRouter.delete("/app/config/local", async (c) => {
  if (c.req.query("confirm") !== FORGET_LOCAL_APP_CONFIRMATION) {
    return c.json(
      {
        error: {
          code: "CONFIRMATION_REQUIRED",
          message:
            "Pass confirm=forget-local-github-app to forget the unreadable GitHub App configuration locally.",
        },
      },
      400
    )
  }

  const reset = await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db
    const config = await lockGitHubAppConfigForReset(transactionDb)
    if (config) {
      try {
        await decryptAppPrivateKey(config)
        return false
      } catch (err) {
        if (!(err instanceof GitHubAppCredentialsError)) {
          throw err
        }
      }
    }

    await deleteGitHubAppLocalState(transactionDb)
    return true
  })
  if (!reset) {
    return c.json(
      {
        error: {
          code: "GITHUB_APP_LOCAL_RESET_NOT_ALLOWED",
          message:
            "The GitHub App credentials are readable. Use the standard reset to uninstall remote installations first.",
        },
      },
      409
    )
  }

  evictAllInstallationTokens()
  log.warn(
    { remoteInstallationsModified: false },
    "forgot unreadable GitHub App configuration locally"
  )
  return c.json({
    ok: true,
    forgotten: true,
    remoteInstallationsModified: false,
  })
})

// ---------------------------------------------------------------------------
// DELETE /github/app/config  (auth required — destructive admin reset)
// ---------------------------------------------------------------------------

githubRouter.delete("/app/config", async (c) => {
  if (c.req.query("confirm") !== RESET_APP_CONFIRMATION) {
    return c.json(
      {
        error: "confirmation_required",
        message:
          "Pass confirm=uninstall-github-installations to uninstall all GitHub App installations before deleting the local config.",
      },
      400
    )
  }

  const config = await getGitHubAppConfig(db)
  if (!config) {
    const reset = await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as typeof db
      const currentConfig = await lockGitHubAppConfigForReset(transactionDb)
      if (currentConfig) return false
      await deleteGitHubAppLocalState(transactionDb)
      return true
    })
    if (!reset) {
      return c.json(
        {
          error: {
            code: "GITHUB_APP_CONFIG_CHANGED",
            message:
              "The GitHub App configuration changed during reset. Retry using the appropriate reset flow.",
          },
        },
        409
      )
    }
    evictAllInstallationTokens()
    return c.json({ ok: true, uninstalled: 0 })
  }

  let installations: Awaited<ReturnType<typeof listAppInstallations>>
  try {
    installations = await listAppInstallations()
  } catch (err) {
    log.error({ err }, "github app reset failed while listing installations")
    if (err instanceof GitHubAppCredentialsError) {
      return c.json(
        {
          error: {
            code: "GITHUB_APP_CREDENTIALS_UNREADABLE",
            message: GITHUB_APP_CREDENTIALS_UNREADABLE_MESSAGE,
          },
        },
        500
      )
    }
    return c.json(
      {
        error: {
          code: "GITHUB_API_ERROR",
          message: "Unable to list GitHub App installations.",
        },
      },
      502
    )
  }

  for (const installation of installations) {
    try {
      await revokeAppInstallation(installation.id)
    } catch (err) {
      log.error(
        { err, installationId: installation.id },
        "github app reset failed while revoking installation"
      )
      return c.json(
        {
          error: {
            code: "GITHUB_API_ERROR",
            message: "Unable to uninstall the GitHub App installation.",
          },
          failed_installation_id: installation.id,
        },
        502
      )
    }
  }

  const reset = await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db
    const currentConfig = await lockGitHubAppConfigForReset(transactionDb)
    if (currentConfig && !isSameStoredGitHubApp(config, currentConfig)) {
      return false
    }
    await deleteGitHubAppLocalState(transactionDb)
    return true
  })
  if (!reset) {
    return c.json(
      {
        error: {
          code: "GITHUB_APP_CONFIG_CHANGED",
          message:
            "The GitHub App configuration changed during reset. The current local configuration was preserved.",
        },
      },
      409
    )
  }
  evictAllInstallationTokens()
  return c.json({ ok: true, uninstalled: installations.length })
})

// [S4.2.A App flow — END]

// [S4.2.B webhook — BEGIN]

// ---------------------------------------------------------------------------
// POST /github/webhook  (public — called by GitHub)
// CSRF is exempted in app.ts because GitHub cannot send the double-submit token.
// Authenticity is verified via HMAC-SHA256 signature on the raw body.
// ---------------------------------------------------------------------------

githubRouter.post("/webhook", githubWebhookRateLimit, async (c) => {
  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "app not configured" }, 503)
  }

  // Read raw body before any parsing
  const body = await c.req.text()
  const rawBodyBuffer = Buffer.from(body, "utf-8")
  const signature = c.req.header("x-hub-signature-256") ?? null
  const event = c.req.header("x-github-event") ?? "unknown"
  const deliveryId = c.req.header("x-github-delivery") ?? "unknown"

  // Compute payload hash for dedup and audit (SHA-256 of raw body)
  const payloadHash = createHash("sha256").update(rawBodyBuffer).digest("hex")

  // Decrypt webhook secret. Empty string = App was created without a webhook
  // (manifest without hook_attributes, typical of loopback dev setups).
  const webhookSecret = await decryptField(
    config.webhook_secret_enc as Buffer,
    config.webhook_secret_nonce as Buffer
  )

  if (webhookSecret.length === 0) {
    return c.json({ error: "webhook not configured for this GitHub App" }, 503)
  }

  if (!verifySignature(body, signature, webhookSecret)) {
    log.warn(
      { signature: signature?.slice(0, 20) },
      "webhook signature rejected"
    )
    return c.json({ error: "invalid signature" }, 401)
  }

  // Dedup only after the HMAC passes; otherwise an invalid delivery can shadow
  // a later valid retry with the same body hash.
  const existing = await findRecentByPayloadHash(db, payloadHash)
  if (existing) {
    log.debug({ deliveryId, payloadHash }, "duplicate payload — dedup skip")
    return c.json({ ok: true, dedup: true })
  }

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return c.json({ error: "invalid json" }, 400)
  }

  // Respond 200 quickly — process async to avoid GitHub timeout (10s)
  queueMicrotask(() =>
    handleWebhook(
      db,
      event,
      payload,
      deliveryId,
      { payloadHash, rawBodyBuffer },
      { enqueue: enqueueProviderReposSync }
    ).catch((err) =>
      log.error({ err, event, deliveryId }, "webhook handler failed")
    )
  )

  return c.json({ ok: true })
})

// [S4.2.B webhook — END]

// ---------------------------------------------------------------------------
// Dropped OAuth endpoints (S4.2.B) — 410 Gone stubs
// These routes were served by the Legacy OAuth App flow which is now removed.
// Stubs prevent 404s from old bookmarks / caches in transitional period.
// ---------------------------------------------------------------------------

githubRouter.get("/auth/connect", (c) =>
  c.json(
    {
      error: "oauth_removed",
      message: "Legacy OAuth removed. Use GitHub App.",
    },
    410
  )
)
githubRouter.get("/auth/callback", (c) =>
  c.json(
    {
      error: "oauth_removed",
      message: "Legacy OAuth removed. Use GitHub App.",
    },
    410
  )
)
githubRouter.delete("/auth/disconnect", (c) =>
  c.json(
    {
      error: "oauth_removed",
      message: "Legacy OAuth removed. Use GitHub App.",
    },
    410
  )
)
githubRouter.get("/status", (c) =>
  c.json(
    {
      error: "oauth_removed",
      message: "Legacy OAuth removed. Use GitHub App.",
    },
    410
  )
)
