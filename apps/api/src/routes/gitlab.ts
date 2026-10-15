// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import { nanoid } from "nanoid"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import {
  discoverRepositoryTargets,
  defaultRepositoryTarget,
  ENV_FILE_PROBE_KEYS,
  MANIFEST_FILE_PROBE_KEYS,
  ManifestTooLargeError,
} from "@ploydok/shared"
import { createDb, createRedis } from "@ploydok/db"
import type { Redis } from "@ploydok/db"
import {
  deleteGitLabConfig,
  deleteGitLabTokens,
  getCacheStatus,
  getGitLabConfig,
  getInstallationStaleness,
  listInstallations,
  listRepos,
  saveGitLabConfig,
  upsertGitLabTokens,
} from "@ploydok/db/queries"
import type { ProviderRepoRow } from "@ploydok/db/queries"
import { provider_credentials } from "@ploydok/db"
import { enqueueProviderReposSync } from "../worker/handlers/sync-provider-repos"
import { decryptField, encryptField } from "../github/app-credentials"
import { resolveGitLabConnection } from "../gitlab/connection"
import { handleGitLabWebhook, verifyGitLabToken } from "../gitlab/webhook"
import { findRecentByPayloadHash } from "../webhooks/deliveries"
import { gitlabWebhookRateLimit } from "../webhooks/rate-limiters"
import { childLogger } from "../logger"
import { env } from "../env"
import { shouldUseSecureCookies } from "../auth/jwt"
import type { AuthUser } from "../auth/middleware"
import { requireInstanceAdmin } from "../auth/instance-admin"
import {
  GITLAB_RETURN_FALLBACK,
  buildReturnUrl,
  sanitizeReturnTo,
} from "./provider-return"
import type { ProviderReturnPath } from "./provider-return"
import { isAllowedNestedProviderFilePath } from "./provider-file-path"

const log = childLogger("gitlab.routes")

type GitLabRouterEnv = { Variables: { user?: AuthUser } }
export const gitlabRouter = new Hono<GitLabRouterEnv>()

// Per-router DB singleton (same pattern as routes/github.ts).
const db = createDb(env.DATABASE_URL)
const redis = createRedis(env.REDIS_URL)
const gitlabConfigAdmin = requireInstanceAdmin(db)

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

function isAllowedEnvFilePath(path: string): boolean {
  return isAllowedNestedProviderFilePath(path, ENV_FILE_PROBE_KEYS)
}

function isAllowedManifestFilePath(path: string): boolean {
  return isAllowedNestedProviderFilePath(path, MANIFEST_FILE_PROBE_KEYS)
}

export function gitLabDbRowToWire(row: ProviderRepoRow) {
  const numericId = Number(row.id.replace(/^gitlab:/, ""))
  return {
    id: Number.isSafeInteger(numericId) && numericId > 0 ? numericId : row.id,
    fullName: row.full_name,
    description: row.description ?? null,
    private: row.private,
    defaultBranch: row.default_branch ?? "main",
    cloneUrl: row.html_url ? row.html_url.replace(/\.git$|\/?$/, ".git") : "",
  }
}

// ---------------------------------------------------------------------------
// State cookie helpers (OAuth anti-CSRF + redirect-after-connect)
// ---------------------------------------------------------------------------

const OAUTH_STATE_COOKIE = "gl_oauth_state"
const OAUTH_STATE_TTL_SECONDS = 10 * 60
const OAUTH_NONCE_PREFIX = "oauth:gitlab:nonce:"

function oauthNonceKey(nonce: string): string {
  return `${OAUTH_NONCE_PREFIX}${nonce}`
}

async function storeOAuthNonce(
  nonceStore: Redis,
  nonce: string,
  expiresAt: number,
  userId: string,
  sessionId: string
): Promise<boolean> {
  const result = await nonceStore.set(
    oauthNonceKey(nonce),
    JSON.stringify([expiresAt, userId, sessionId]),
    "EX",
    OAUTH_STATE_TTL_SECONDS,
    "NX"
  )
  return result === "OK"
}

async function consumeOAuthNonce(
  nonceStore: Redis,
  nonce: string,
  expiresAt: number,
  userId: string,
  sessionId: string
): Promise<boolean> {
  const expected = JSON.stringify([expiresAt, userId, sessionId])
  const consumed = await nonceStore.eval(
    `local current = redis.call("GET", KEYS[1])
     if current == ARGV[1] then
       redis.call("DEL", KEYS[1])
       return 1
     end
     return 0`,
    1,
    oauthNonceKey(nonce),
    expected
  )
  return consumed === 1
}

/** Constant-time check that the cookie's prefix carries a valid MAC. */
function verifySignedPrefix(cookieValue: string): string | null {
  const lastDot = cookieValue.lastIndexOf(".")
  if (lastDot === -1) return null
  const payload = cookieValue.slice(0, lastDot)
  const mac = cookieValue.slice(lastDot + 1)
  const expected = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("hex")
  const a = Buffer.from(expected, "hex")
  const b = Buffer.from(mac, "hex")
  if (a.length !== b.length) return null
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0 ? payload : null
}

function signState(
  state: string,
  userId: string,
  sessionId: string,
  returnTo: ProviderReturnPath,
  issuedAtSeconds: number,
  expiresAtSeconds: number
): string {
  const payload = Buffer.from(
    JSON.stringify({
      state,
      nonce: state,
      userId,
      sessionId,
      returnTo,
      iat: issuedAtSeconds,
      exp: expiresAtSeconds,
    })
  ).toString("base64url")
  const mac = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("hex")
  return `${payload}.${mac}`
}

function verifyState(
  cookieValue: string,
  state: string
): {
  userId: string
  sessionId: string
  returnTo: ProviderReturnPath
  exp: number
} | null {
  const payload = verifySignedPrefix(cookieValue)
  if (payload === null) return null

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      state?: unknown
      userId?: unknown
      sessionId?: unknown
      returnTo?: unknown
      nonce?: unknown
      iat?: unknown
      exp?: unknown
    }
    const now = Math.floor(Date.now() / 1000)
    if (
      parsed.state !== state ||
      parsed.nonce !== state ||
      typeof parsed.userId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      parsed.iat > now + 30 ||
      parsed.exp < now
    )
      return null
    return {
      userId: parsed.userId,
      sessionId: parsed.sessionId,
      returnTo: sanitizeReturnTo(parsed.returnTo, GITLAB_RETURN_FALLBACK),
      exp: parsed.exp,
    }
  } catch {
    return null
  }
}

function buildCookie(
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

function clearCookie(name: string): string {
  const parts = [`${name}=`, "Path=/", "Max-Age=0", "SameSite=Lax"]
  if (shouldUseSecureCookies()) parts.push("Secure")
  return parts.join("; ")
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k === name) return decodeURIComponent(v)
  }
  return null
}

// ---------------------------------------------------------------------------
// OAuth app config (singleton, admin-managed)
// ---------------------------------------------------------------------------

gitlabRouter.get("/config", async (c) => {
  const cfg = await getGitLabConfig(db)
  // callback_url is echoed even when unconfigured: the admin has to paste this
  // exact value into GitLab before they can produce a client_id, and it must
  // match the redirect_uri we send at /connect or GitLab rejects the exchange.
  if (!cfg) {
    return c.json({
      configured: false,
      callback_url: env.GITLAB_OAUTH_CALLBACK_URL,
    })
  }
  return c.json({
    configured: true,
    instance_url: cfg.instance_url,
    client_id: cfg.client_id,
    callback_url: env.GITLAB_OAUTH_CALLBACK_URL,
  })
})

gitlabRouter.post("/config", gitlabConfigAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (!body) return c.json({ error: "invalid_json" }, 400)

  const instanceUrlRaw =
    (body["instance_url"] as string | undefined) ?? "https://gitlab.com"
  let instanceUrl: URL
  try {
    instanceUrl = new URL(instanceUrlRaw)
  } catch {
    return c.json({ error: "invalid_instance_url" }, 400)
  }
  if (
    instanceUrl.protocol !== "https:" &&
    instanceUrl.hostname !== "localhost" &&
    instanceUrl.hostname !== "127.0.0.1"
  ) {
    return c.json({ error: "insecure_instance_url" }, 400)
  }

  const clientId = (body["client_id"] as string | undefined) ?? ""
  const clientSecret = (body["client_secret"] as string | undefined) ?? ""
  const webhookSecret = (body["webhook_secret"] as string | undefined) ?? ""

  if (!clientId || !clientSecret) {
    return c.json({ error: "missing_credentials" }, 400)
  }

  const cs = await encryptField(clientSecret)
  const ws = await encryptField(webhookSecret)

  await saveGitLabConfig(db, {
    instance_url: instanceUrl.toString().replace(/\/$/, ""),
    client_id: clientId,
    client_secret_enc: cs.enc,
    client_secret_nonce: cs.nonce,
    webhook_secret_enc: ws.enc,
    webhook_secret_nonce: ws.nonce,
  })

  return c.json({ ok: true })
})

gitlabRouter.delete("/config", gitlabConfigAdmin, async (c) => {
  await deleteGitLabConfig(db)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// OAuth connect: redirect user to GitLab authorize endpoint
// ---------------------------------------------------------------------------

gitlabRouter.get("/connect", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const cfg = await getGitLabConfig(db)
  if (!cfg) return c.json({ error: "gitlab_not_configured" }, 503)

  const returnTo = sanitizeReturnTo(
    c.req.query("return_to"),
    GITLAB_RETURN_FALLBACK
  )
  const nowSeconds = Math.floor(Date.now() / 1000)
  const expiresAtSeconds = nowSeconds + OAUTH_STATE_TTL_SECONDS
  let state = ""
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = randomBytes(16).toString("hex")
    if (
      await storeOAuthNonce(
        redis,
        candidate,
        expiresAtSeconds,
        user.id,
        user.session_id
      )
    ) {
      state = candidate
      break
    }
  }
  if (!state) return c.json({ error: "oauth_state_unavailable" }, 503)
  const authorizeUrl = new URL(`${cfg.instance_url}/oauth/authorize`)
  authorizeUrl.searchParams.set("client_id", cfg.client_id)
  authorizeUrl.searchParams.set("redirect_uri", env.GITLAB_OAUTH_CALLBACK_URL)
  authorizeUrl.searchParams.set("response_type", "code")
  // `api` covers project listing + branches; `read_repository` is sufficient for clone
  // but we need `api` to discover user's projects via /projects?membership=true.
  authorizeUrl.searchParams.set("scope", "api read_repository")
  authorizeUrl.searchParams.set("state", state)

  c.header(
    "Set-Cookie",
    buildCookie(
      OAUTH_STATE_COOKIE,
      signState(
        state,
        user.id,
        user.session_id,
        returnTo,
        nowSeconds,
        expiresAtSeconds
      ),
      OAUTH_STATE_TTL_SECONDS,
      true
    )
  )
  return c.redirect(authorizeUrl.toString())
})

// ---------------------------------------------------------------------------
// OAuth callback: exchange code for tokens, store encrypted per user
// ---------------------------------------------------------------------------

gitlabRouter.get("/callback", async (c) => {
  const state = c.req.query("state")
  if (!state) return c.json({ error: "missing_state" }, 400)

  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const cookieVal = parseCookie(
    c.req.header("cookie") ?? "",
    OAUTH_STATE_COOKIE
  )
  const oauthState = cookieVal ? verifyState(cookieVal, state) : null
  if (!oauthState) {
    return c.json({ error: "invalid_state" }, 400)
  }
  // Read only from the MAC-verified payload, never from the query string.
  const returnTo = sanitizeReturnTo(oauthState.returnTo, GITLAB_RETURN_FALLBACK)
  c.header("Set-Cookie", clearCookie(OAUTH_STATE_COOKIE))

  if (
    oauthState.userId !== user.id ||
    oauthState.sessionId !== user.session_id
  ) {
    return c.json({ error: "oauth_user_mismatch" }, 403)
  }
  if (
    !(await consumeOAuthNonce(
      redis,
      state,
      oauthState.exp,
      user.id,
      user.session_id
    ))
  ) {
    return c.json({ error: "invalid_state" }, 400)
  }

  const providerError = c.req.query("error")
  if (providerError) {
    const errorCode =
      providerError === "access_denied" ? "access_denied" : "oauth_error"
    return c.redirect(
      buildReturnUrl(returnTo, new URLSearchParams({ gitlab_error: errorCode }))
    )
  }

  const code = c.req.query("code")
  if (!code) {
    return c.redirect(
      buildReturnUrl(
        returnTo,
        new URLSearchParams({ gitlab_error: "missing_code" })
      )
    )
  }

  const cfg = await getGitLabConfig(db)
  if (!cfg) {
    return c.redirect(
      buildReturnUrl(
        returnTo,
        new URLSearchParams({ gitlab_error: "not_configured" })
      )
    )
  }

  const clientSecret = await decryptField(
    cfg.client_secret_enc as Buffer,
    cfg.client_secret_nonce as Buffer
  )

  const tokenUrl = `${cfg.instance_url}/oauth/token`
  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.client_id,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.GITLAB_OAUTH_CALLBACK_URL,
    }),
  })

  if (!tokenRes.ok) {
    const body = await tokenRes.text()
    log.warn({ status: tokenRes.status, body }, "gitlab token exchange failed")
    return c.redirect(
      buildReturnUrl(
        returnTo,
        new URLSearchParams({ gitlab_error: "exchange_failed" })
      )
    )
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    created_at?: number
  }

  const at = await encryptField(tokens.access_token)
  const rt = tokens.refresh_token
    ? await encryptField(tokens.refresh_token)
    : null
  const expiresAt =
    tokens.expires_in && tokens.created_at
      ? new Date((tokens.created_at + tokens.expires_in) * 1000)
      : tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null

  await upsertGitLabTokens(db, {
    user_id: user.id,
    access_token_enc: at.enc,
    access_token_nonce: at.nonce,
    refresh_token_enc: rt?.enc ?? null,
    refresh_token_nonce: rt?.nonce ?? null,
    expires_at: expiresAt,
  })

  const credentialId = `gitlab:user:${user.id}`
  await db
    .insert(provider_credentials)
    .values({
      id: credentialId,
      provider: "gitlab",
      credential_type: "user",
      last_sync_status: "pending",
      last_sync_actor_user_id: user.id,
      last_sync_source: "api",
    })
    .onConflictDoUpdate({
      target: provider_credentials.id,
      set: {
        last_sync_status: "pending",
        last_sync_actor_user_id: user.id,
        last_sync_source: "api",
        updated_at: new Date(),
      },
    })
  await enqueueProviderReposSync({
    provider: "gitlab",
    userId: user.id,
    requestedBy: user.id,
    syncId: nanoid(),
  })

  // Back to whichever surface started the flow: onboarding wizard or settings.
  return c.redirect(
    buildReturnUrl(
      returnTo,
      new URLSearchParams({
        connected: "1",
        sync: "queued",
        source: "gitlab",
      })
    )
  )
})

// ---------------------------------------------------------------------------
// Disconnect: drop stored tokens for this user
// ---------------------------------------------------------------------------

gitlabRouter.delete("/connect", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)
  await deleteGitLabTokens(db, user.id)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// POST /gitlab/installations/sync — manual force-refresh of the cached repos
// for the current user.
// ---------------------------------------------------------------------------

gitlabRouter.post("/installations/sync", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)
  const syncId = nanoid()
  const credentialId = `gitlab:user:${user.id}`

  await db
    .insert(provider_credentials)
    .values({
      id: credentialId,
      provider: "gitlab",
      credential_type: "user",
      last_sync_status: "pending",
      last_sync_actor_user_id: user.id,
      last_sync_source: "api",
    })
    .onConflictDoUpdate({
      target: provider_credentials.id,
      set: {
        last_sync_status: "pending",
        last_sync_actor_user_id: user.id,
        last_sync_source: "api",
        updated_at: new Date(),
      },
    })

  await enqueueProviderReposSync({
    provider: "gitlab",
    userId: user.id,
    requestedBy: user.id,
    syncId,
  })
  log.info({ userId: user.id, syncId }, "manual gitlab sync enqueued")
  return c.json({ enqueued: true, syncId }, 202)
})

// ---------------------------------------------------------------------------
// GET /gitlab/installations/cache-status — freshness + repo count for the
// current user's cached installation.
// ---------------------------------------------------------------------------

gitlabRouter.get("/installations/cache-status", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const installationId = `gitlab:user:${user.id}`
  const [rows, credentialRows] = await Promise.all([
    getCacheStatus(db, "gitlab", installationId),
    db
      .select({ status: provider_credentials.last_sync_status })
      .from(provider_credentials)
      .where(eq(provider_credentials.id, installationId))
      .limit(1),
  ])
  const now = Date.now()

  return c.json({
    installation:
      rows[0] != null
        ? {
            id: rows[0].id,
            externalId: rows[0].externalId,
            accountLogin: rows[0].accountLogin,
            avatarUrl: rows[0].avatarUrl,
            htmlUrl: rows[0].htmlUrl,
            lastSyncedAt: rows[0].lastSyncedAt.toISOString(),
            repoCount: rows[0].repoCount,
            ageMs: now - rows[0].lastSyncedAt.getTime(),
            status:
              now - rows[0].lastSyncedAt.getTime() > STALE_THRESHOLD_MS
                ? "stale"
                : "fresh",
          }
        : null,
    staleThresholdMs: STALE_THRESHOLD_MS,
    syncStatus: credentialRows[0]?.status ?? null,
  })
})

// ---------------------------------------------------------------------------
// Repos / branches (per-user OAuth token)
// ---------------------------------------------------------------------------

async function getProviderAndTokenForUser(userId: string) {
  try {
    return await resolveGitLabConnection(db, userId)
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null
    if (code === "not_connected" || code === "expired") return null
    throw error
  }
}

const STALE_THRESHOLD_MS = 10 * 60 * 1000

gitlabRouter.get("/repos", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const page = Math.max(1, Number(c.req.query("page") ?? 1))
  const perPage = Math.min(
    100,
    Math.max(1, Number(c.req.query("per_page") ?? 30))
  )
  const search = c.req.query("search") ?? undefined

  const installationId = `gitlab:user:${user.id}`
  const ctx = await getProviderAndTokenForUser(user.id)
  if (!ctx) {
    return c.json({ error: "gitlab_not_connected", needsConnect: true }, 412)
  }
  const installations = await listInstallations(db, "gitlab", [installationId])
  const userInstall = installations.find((i) => i.id === installationId)

  if (!userInstall) {
    const credentialId = `gitlab:user:${user.id}`
    db.insert(provider_credentials)
      .values({
        id: credentialId,
        provider: "gitlab",
        credential_type: "user",
        last_sync_status: "pending",
        last_sync_source: "system",
      })
      .onConflictDoUpdate({
        target: provider_credentials.id,
        set: {
          last_sync_status: "pending",
          last_sync_source: "system",
          updated_at: new Date(),
        },
      })
      .catch((err) => log.warn({ err }, "upsert credential failed"))

    enqueueProviderReposSync({ provider: "gitlab", userId: user.id }).catch(
      (err) => {
        log.warn({ err }, "enqueueProviderReposSync failed")
      }
    )
    return c.json({
      repos: [],
      page,
      perPage,
      hasMore: false,
      needsConnect: true,
    })
  }

  const staleness = await getInstallationStaleness(db, "gitlab", [
    installationId,
  ])
  if (
    staleness.mostStaleAt !== null &&
    Date.now() - staleness.mostStaleAt.getTime() > STALE_THRESHOLD_MS
  ) {
    const credentialId = `gitlab:user:${user.id}`
    db.insert(provider_credentials)
      .values({
        id: credentialId,
        provider: "gitlab",
        credential_type: "user",
        last_sync_status: "pending",
        last_sync_source: "system",
      })
      .onConflictDoUpdate({
        target: provider_credentials.id,
        set: {
          last_sync_status: "pending",
          last_sync_source: "system",
          updated_at: new Date(),
        },
      })
      .catch((err) => log.warn({ err }, "upsert credential failed"))

    enqueueProviderReposSync({ provider: "gitlab", userId: user.id }).catch(
      (err) => {
        log.warn({ err }, "background enqueueProviderReposSync failed")
      }
    )
  }

  const { rows, total } = await listRepos(db, {
    provider: "gitlab",
    ...(search !== undefined && { search }),
    installationIds: [installationId],
    limit: perPage,
    offset: (page - 1) * perPage,
  })

  return c.json({
    repos: rows.map(gitLabDbRowToWire),
    page,
    perPage,
    hasMore: (page - 1) * perPage + rows.length < total,
  })
})

gitlabRouter.get("/repos/:fullName{.+}/branches", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const ctx = await getProviderAndTokenForUser(user.id)
  if (!ctx) return c.json({ error: "gitlab_not_connected" }, 412)

  const fullName = c.req.param("fullName")
  const search = c.req.query("search")?.trim() || undefined
  try {
    const branches = await ctx.provider.listBranches(
      ctx.accessToken,
      fullName,
      {
        ...(search ? { search } : {}),
      }
    )
    return c.json({ branches })
  } catch (err) {
    log.error({ err, fullName }, "listBranches failed")
    return c.json({ error: "gitlab_api_error" }, 502)
  }
})

gitlabRouter.get("/repos/:fullName{.+}/file-exists", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const ctx = await getProviderAndTokenForUser(user.id)
  if (!ctx) return c.json({ error: "gitlab_not_connected" }, 412)

  const fullName = c.req.param("fullName")
  const filePath = c.req.query("path")
  const ref = c.req.query("ref")
  if (!filePath || !ref) {
    return c.json({ error: "missing_path_or_ref" }, 400)
  }

  try {
    const exists = await ctx.provider.fileExists(
      ctx.accessToken,
      fullName,
      filePath,
      ref
    )
    return c.json({ exists })
  } catch (err) {
    log.error({ err, fullName, filePath }, "fileExists failed")
    return c.json({ error: "gitlab_api_error" }, 502)
  }
})

gitlabRouter.get("/repos/:fullName{.+}/files-exist", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const ctx = await getProviderAndTokenForUser(user.id)
  if (!ctx) return c.json({ error: "gitlab_not_connected" }, 412)

  const fullName = c.req.param("fullName")
  const query = readFileProbeQuery(c.req.url)
  if (!query) {
    return c.json({ error: "missing_or_invalid_paths_or_ref" }, 400)
  }

  try {
    const entries = await Promise.all(
      query.paths.map(
        async (filePath) =>
          [
            filePath,
            await ctx.provider.fileExists(
              ctx.accessToken,
              fullName,
              filePath,
              query.ref
            ),
          ] as const
      )
    )
    return c.json({ files: Object.fromEntries(entries) })
  } catch (err) {
    log.error({ err, fullName }, "filesExist failed")
    return c.json({ error: "gitlab_api_error" }, 502)
  }
})

gitlabRouter.get("/repos/:fullName{.+}/deployment-targets", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)
  const ctx = await getProviderAndTokenForUser(user.id)
  if (!ctx) return c.json({ error: "gitlab_not_connected" }, 412)
  const ref = c.req.query("ref")?.trim()
  if (!ref) return c.json({ error: "missing_ref" }, 400)
  const fullName = c.req.param("fullName")
  try {
    const paths = await ctx.provider.listFiles(ctx.accessToken, fullName, ref)
    const targets = await discoverRepositoryTargets(paths, (path) =>
      ctx.provider.readFile(ctx.accessToken, fullName, path, ref)
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
    return c.json({ error: "repository_detection_unavailable" }, 502)
  }
})

gitlabRouter.get("/repos/:fullName{.+}/env-file", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const ctx = await getProviderAndTokenForUser(user.id)
  if (!ctx) return c.json({ error: "gitlab_not_connected" }, 412)

  const fullName = c.req.param("fullName")
  const filePath = c.req.query("path")?.trim() ?? ""
  const ref = c.req.query("ref")?.trim() ?? ""
  if (!filePath || !ref || !isAllowedEnvFilePath(filePath)) {
    return c.json({ error: "missing_or_invalid_path_or_ref" }, 400)
  }

  try {
    const content = await ctx.provider.readFile(
      ctx.accessToken,
      fullName,
      filePath,
      ref
    )
    return c.json({ path: filePath, content })
  } catch (err) {
    log.error({ err, fullName, filePath }, "envFile read failed")
    return c.json({ error: "gitlab_api_error" }, 502)
  }
})

gitlabRouter.get("/repos/:fullName{.+}/manifest-file", async (c) => {
  const user = c.get("user") ?? null
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const ctx = await getProviderAndTokenForUser(user.id)
  if (!ctx) return c.json({ error: "gitlab_not_connected" }, 412)

  const fullName = c.req.param("fullName")
  const filePath = c.req.query("path")?.trim() ?? ""
  const ref = c.req.query("ref")?.trim() ?? ""
  if (!filePath || !ref || !isAllowedManifestFilePath(filePath)) {
    return c.json({ error: "missing_or_invalid_path_or_ref" }, 400)
  }

  try {
    const content = await ctx.provider.readFile(
      ctx.accessToken,
      fullName,
      filePath,
      ref
    )
    return c.json({ path: filePath, content })
  } catch (err) {
    if (err instanceof ManifestTooLargeError) {
      return c.json({ error: "MANIFEST_TOO_LARGE", detail: filePath }, 413)
    }
    log.error({ err, fullName, filePath }, "manifestFile read failed")
    return c.json({ error: "gitlab_api_error" }, 502)
  }
})

// ---------------------------------------------------------------------------
// Webhook receiver — GitLab sends `X-Gitlab-Token` header (plain shared secret).
// ---------------------------------------------------------------------------

gitlabRouter.post("/webhook", gitlabWebhookRateLimit, async (c) => {
  const cfg = await getGitLabConfig(db)
  if (!cfg) return c.json({ error: "gitlab_not_configured" }, 503)

  const body = await c.req.text()
  const rawBodyBuffer = Buffer.from(body, "utf-8")
  const token = c.req.header("x-gitlab-token") ?? null
  const event = c.req.header("x-gitlab-event") ?? "unknown"
  const deliveryId = c.req.header("x-gitlab-event-uuid") ?? "unknown"

  // Compute payload hash for dedup and audit (SHA-256 of raw body)
  const payloadHash = createHash("sha256").update(rawBodyBuffer).digest("hex")

  const expected = await decryptField(
    cfg.webhook_secret_enc as Buffer,
    cfg.webhook_secret_nonce as Buffer
  )
  if (expected.length === 0) {
    return c.json({ error: "webhook_secret_missing" }, 503)
  }
  if (!verifyGitLabToken(token, expected)) {
    log.warn({ event }, "gitlab webhook token rejected")
    return c.json({ error: "invalid_token" }, 401)
  }

  // Dedup only after the shared token passes; otherwise an invalid delivery can
  // shadow a later valid retry with the same body hash.
  const existing = await findRecentByPayloadHash(db, payloadHash)
  if (existing) {
    log.debug({ deliveryId, payloadHash }, "duplicate payload — dedup skip")
    return c.json({ ok: true, dedup: true })
  }

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return c.json({ error: "invalid_json" }, 400)
  }

  queueMicrotask(() =>
    handleGitLabWebhook(db, event, payload, deliveryId, {
      payloadHash,
      rawBodyBuffer,
    }).catch((err) =>
      log.error({ err, event, deliveryId }, "gitlab webhook handler failed")
    )
  )

  return c.json({ ok: true })
})
