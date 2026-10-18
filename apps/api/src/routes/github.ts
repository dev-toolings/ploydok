// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type MiddlewareHandler } from "hono"
import { nanoid } from "nanoid"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { z } from "zod"
import { and, eq, isNotNull, or } from "drizzle-orm"
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
  grantGitHubInstallationToOrganization,
  getCacheStatus,
  getGitHubAppConfig,
  getGitHubAppConfigByAppId,
  getGitHubAppConfigForInstallation,
  getInstallationStaleness,
  listGitHubAppConfigs,
  lockGitHubAppConfigForReset,
  lockGitHubAppConfigForUse,
  listInstallations,
  listGitHubInstallationIdsForOrganization,
  listGitHubInstallationIdsForOrganizationAndUser,
  listGitHubInstallationIdsForUser,
  listRepos,
  organizationHasGitHubInstallationGrant,
  revokeGitHubInstallationFromOrganization,
  saveGitHubAppConfig,
  upsertInstallation,
  userOwnsGitHubInstallation,
} from "@ploydok/db/queries"
import type { GitHubAppRow, ProviderRepoRow } from "@ploydok/db/queries"
import {
  audit_log,
  memberships,
  projects,
  provider_credentials,
  provider_installations,
} from "@ploydok/db"
import type { Db } from "@ploydok/db"
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
import { requireScope } from "../auth/require-scope"

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
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
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
const githubWriteScope = requireScope("apps:write")

const githubOwnerSession: MiddlewareHandler<GithubRouterEnv> = async (c, next) => {
  const user = c.get("user")
  if (user?.pat_id || user?.token_scopes !== undefined) {
    return c.json({ error: "session_required" }, 403)
  }
  return next()
}

async function writeGitHubInstallationAudit(
  transactionDb: Pick<Db, "insert">,
  input: {
    action:
      | "github.installation.claimed"
      | "github.installation.granted"
      | "github.installation.revoked"
    organizationId: string
    installationId: string
    actorUserId: string
  }
): Promise<void> {
  await transactionDb.insert(audit_log).values({
    user_id: input.actorUserId,
    action: input.action,
    target_type: "github_installation",
    target_id: input.installationId,
    org_id: input.organizationId,
    metadata: JSON.stringify({
      organization_id: input.organizationId,
      installation_id: input.installationId,
      actor_user_id: input.actorUserId,
    }),
    created_at: new Date(),
  })
}

githubRouter.use("/app/manifest", githubAppAdmin)
githubRouter.use("/app/import", githubAppAdmin)
githubRouter.use("/app/config", githubAppAdmin)
githubRouter.use("/app/config/local", githubAppAdmin)
githubRouter.use("/app/credentials/status", githubAppAdmin)
githubRouter.use("/app/organization-lookup", githubAppAdmin)

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
const INSTALL_OAUTH_STATE_COOKIE = "gh_install_oauth_state"
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
  returnTo: ProviderReturnPath = GITHUB_RETURN_FALLBACK,
  organizationId?: string,
  claimInstallationId?: string,
  githubAppId?: string
): string {
  const payload = Buffer.from(
    JSON.stringify({
      state,
      userId,
      returnTo,
      issuedAt: Date.now(),
      ...(organizationId ? { organizationId } : {}),
      ...(claimInstallationId ? { claimInstallationId } : {}),
      ...(githubAppId ? { githubAppId } : {}),
    })
  ).toString("base64url")
  const mac = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("hex")
  return `${payload}.${mac}`
}

function verifyInstallState(
  cookieValue: string,
  state: string
): {
  userId: string
  returnTo: ProviderReturnPath
  organizationId: string | null
  claimInstallationId: string | null
  githubAppId: string | null
} | null {
  const payload = verifySignedPrefix(cookieValue)
  if (payload === null) return null

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      state?: unknown
      userId?: unknown
      returnTo?: unknown
      organizationId?: unknown
      claimInstallationId?: unknown
      githubAppId?: unknown
      issuedAt?: unknown
    }
    if (parsed.state !== state || typeof parsed.userId !== "string") return null
    if (
      parsed.organizationId &&
      (typeof parsed.issuedAt !== "number" ||
        Date.now() - parsed.issuedAt > APP_STATE_TTL_SECONDS * 1000)
    ) {
      return null
    }
    return {
      userId: parsed.userId,
      returnTo: sanitizeReturnTo(parsed.returnTo, GITHUB_RETURN_FALLBACK),
      organizationId:
        typeof parsed.organizationId === "string"
          ? parsed.organizationId
          : null,
      claimInstallationId:
        typeof parsed.claimInstallationId === "string"
          ? parsed.claimInstallationId
          : null,
      githubAppId:
        typeof parsed.githubAppId === "string" ? parsed.githubAppId : null,
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

function getInstallOAuthCallbackUrl(): string {
  return `${getApiOrigin()}/github/app/callback`
}

function buildInstallOAuthUrl(clientId: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getInstallOAuthCallbackUrl(),
    state,
  })
  return `https://github.com/login/oauth/authorize?${params.toString()}`
}

type InstallOAuthState = {
  state: string
  githubAppId: string
  userId: string
  organizationId: string
  installationId: string
  claimInstallationId: string | null
  setupAction: string | null
  returnTo: ProviderReturnPath
  issuedAt: number
}

function signInstallOAuthState(state: InstallOAuthState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url")
  const mac = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("hex")
  return `${payload}.${mac}`
}

function verifyInstallOAuthState(
  cookieValue: string,
  state: string
): InstallOAuthState | null {
  const payload = verifySignedPrefix(cookieValue)
  if (!payload) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    ) as Partial<InstallOAuthState>
    if (
      parsed.state !== state ||
      typeof parsed.githubAppId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.installationId !== "string" ||
      typeof parsed.issuedAt !== "number" ||
      Date.now() - parsed.issuedAt > APP_STATE_TTL_SECONDS * 1000
    ) {
      return null
    }
    return {
      state: parsed.state,
      githubAppId: parsed.githubAppId,
      userId: parsed.userId,
      organizationId: parsed.organizationId,
      installationId: parsed.installationId,
      claimInstallationId:
        typeof parsed.claimInstallationId === "string"
          ? parsed.claimInstallationId
          : null,
      setupAction:
        typeof parsed.setupAction === "string" ? parsed.setupAction : null,
      returnTo: sanitizeReturnTo(parsed.returnTo, GITHUB_RETURN_FALLBACK),
      issuedAt: parsed.issuedAt,
    }
  } catch {
    return null
  }
}

type GitHubUserInstallationProof = {
  login: string
  accessToken: string
  installations: Awaited<ReturnType<typeof listAppInstallations>>
}

async function verifyGitHubOrganizationAdmin(
  accessToken: string,
  organizationLogin: string,
  userLogin: string
): Promise<"verified" | "not_admin" | "permission_missing"> {
  const response = await fetch(
    `https://api.github.com/orgs/${encodeURIComponent(
      organizationLogin
    )}/memberships/${encodeURIComponent(userLogin)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "ploydok",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    }
  )
  if (response.status === 403) return "permission_missing"
  if (!response.ok) return "not_admin"
  const body = (await response.json()) as {
    state?: unknown
    role?: unknown
  }
  return body.state === "active" && body.role === "admin"
    ? "verified"
    : "not_admin"
}

async function exchangeGitHubUserInstallations(
  code: string,
  config: NonNullable<Awaited<ReturnType<typeof getGitHubAppConfig>>>
): Promise<GitHubUserInstallationProof> {
  const clientSecret = await decryptField(
    config.client_secret_enc as Buffer,
    config.client_secret_nonce as Buffer
  )
  if (!clientSecret) throw new Error("GitHub App OAuth is not configured")

  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "ploydok",
      },
      body: JSON.stringify({
        client_id: config.client_id,
        client_secret: clientSecret,
        code,
        redirect_uri: getInstallOAuthCallbackUrl(),
      }),
      signal: AbortSignal.timeout(10_000),
    }
  )
  if (!tokenResponse.ok) throw new Error("GitHub OAuth token exchange failed")
  const tokenBody = (await tokenResponse.json()) as { access_token?: unknown }
  if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token) {
    throw new Error("GitHub OAuth token exchange returned no token")
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenBody.access_token}`,
      "User-Agent": "ploydok",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!userResponse.ok) throw new Error("GitHub refused to verify the user")
  const userBody = (await userResponse.json()) as { login?: unknown }
  if (typeof userBody.login !== "string" || !userBody.login) {
    throw new Error("GitHub user response did not include a login")
  }

  const installationsResponse = await fetch(
    "https://api.github.com/user/installations?per_page=100",
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenBody.access_token}`,
        "User-Agent": "ploydok",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    }
  )
  if (!installationsResponse.ok) {
    throw new Error("GitHub refused to verify the installation owner")
  }
  const body = (await installationsResponse.json()) as {
    installations?: Array<{
      id: number
      account?: {
        login?: string
        type?: string
        html_url?: string
        avatar_url?: string
      } | null
      repository_selection?: "all" | "selected"
      suspended_at?: string | null
      html_url?: string
    }>
  }
  return {
    login: userBody.login,
    accessToken: tokenBody.access_token,
    installations: (body.installations ?? []).map((installation) => ({
      id: installation.id,
      githubAppId: config.id,
      accountLogin: installation.account?.login ?? "",
      accountType: installation.account?.type ?? "",
      repositorySelection: installation.repository_selection ?? "selected",
      suspendedAt: installation.suspended_at ?? null,
      htmlUrl: installation.html_url ?? installation.account?.html_url ?? "",
      avatarUrl: installation.account?.avatar_url ?? "",
    })),
  }
}

function getApiOrigin(): string {
  return new URL(env.GITHUB_APP_CALLBACK_URL).origin
}

function getInstallationStartUrl(
  organizationId?: string,
  githubAppId?: string
): string {
  const url = new URL("/github/installations/start", getApiOrigin())
  if (organizationId) url.searchParams.set("organizationId", organizationId)
  if (githubAppId) url.searchParams.set("appId", githubAppId)
  return url.toString()
}

/** One install entry point per GitHub App, i.e. per GitHub owner. */
function getInstallTargets(apps: GitHubAppRow[], organizationId?: string) {
  return apps.map((app) => ({
    appId: app.id,
    name: app.name,
    slug: app.slug,
    ownerLogin: app.owner_login,
    ownerType: app.owner_type,
    url: getInstallationStartUrl(organizationId, app.id),
  }))
}

/**
 * Picks the App an install flow targets. Without an explicit id the only App
 * is used; with several Apps the caller must choose, since each one can only
 * be installed on its own GitHub owner.
 */
async function resolveInstallApp(
  appId: string | undefined
): Promise<
  | { app: GitHubAppRow; error?: never }
  | { app?: never; error: "github_app_not_configured" | "github_app_required" }
> {
  if (appId) {
    const app = await getGitHubAppConfig(db, appId)
    return app ? { app } : { error: "github_app_not_configured" }
  }
  const apps = await listGitHubAppConfigs(db)
  if (apps.length === 0) return { error: "github_app_not_configured" }
  if (apps.length > 1) return { error: "github_app_required" }
  return { app: apps[0]! }
}

function getUserId(c: {
  get: (key: "user") => GithubRouterEnv["Variables"]["user"]
}): string | null {
  return c.get("user")?.id ?? null
}

async function getUserGitHubInstallationIds(userId: string): Promise<string[]> {
  return listGitHubInstallationIdsForUser(db, userId)
}

type OrganizationScope = { id: string; role: string } | null

/** Resolve the requested workspace without allowing a cross-tenant fallback. */
async function getOrganizationScope(
  c: { req: { query: (name: string) => string | undefined } },
  userId: string
): Promise<OrganizationScope> {
  const organizationId =
    c.req.query("organizationId") ?? c.req.query("projectId")
  if (!organizationId) return null
  const rows = await db
    .select({ id: projects.id, role: memberships.role })
    .from(projects)
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        isNotNull(memberships.accepted_at)
      )
    )
    .where(eq(projects.id, organizationId))
    .limit(1)
  return rows[0] ?? null
}

async function requireOrganizationOwner(
  c: { req: { query: (name: string) => string | undefined } },
  userId: string
): Promise<{ id: string } | null> {
  const scope = await getOrganizationScope(c, userId)
  return scope?.role === "owner" ? { id: scope.id } : null
}

async function organizationOwnerStillExists(
  organizationId: string,
  userId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.org_id, organizationId),
        eq(memberships.user_id, userId),
        eq(memberships.role, "owner"),
        isNotNull(memberships.accepted_at)
      )
    )
    .limit(1)
  return rows.length > 0
}

async function getScopedGitHubInstallationIds(
  c: { req: { query: (name: string) => string | undefined } },
  userId: string
): Promise<{ organization: OrganizationScope; installationIds: string[] }> {
  const organization = await getOrganizationScope(c, userId)
  if (!organization) {
    return {
      organization: null,
      installationIds: await getUserGitHubInstallationIds(userId),
    }
  }
  return {
    organization,
    installationIds: await listGitHubInstallationIdsForOrganizationAndUser(
      db,
      organization.id,
      userId
    ),
  }
}

function hasOrganizationQuery(c: {
  req: { query: (name: string) => string | undefined }
}): boolean {
  return Boolean(c.req.query("organizationId") ?? c.req.query("projectId"))
}

async function getAccessibleGitHubInstallationIds(
  userId: string,
  organizationId?: string
): Promise<string[]> {
  if (organizationId) {
    return listGitHubInstallationIdsForOrganizationAndUser(
      db,
      organizationId,
      userId
    )
  }
  if (!(await isInstanceAdmin(db, userId))) {
    return getUserGitHubInstallationIds(userId)
  }
  const installations = await listAppInstallations()
  return installations.map((installation) => String(installation.id))
}

async function listUserGitHubInstallations(
  userId: string,
  installationIds?: string[]
) {
  const allowedIds = new Set(
    installationIds ?? (await getUserGitHubInstallationIds(userId))
  )
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

function dbRowToWire(row: ProviderRepoRow, accountLogin?: string) {
  const installationId = normalizeGitHubInstallationId(row.installation_id)
  return {
    id: row.id,
    fullName: row.full_name,
    ...(accountLogin ? { accountLogin } : {}),
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
  if (!hasOrganizationQuery(c)) {
    return c.json({ error: "organization_required" }, 400)
  }
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

  const organization = await getOrganizationScope(c, userId)
  if (!organization) return c.json({ error: "organization_not_found" }, 404)
  const installUrl = getInstallationStartUrl(organization.id)
  const installationIds = await listGitHubInstallationIdsForOrganizationAndUser(
    db,
    organization.id,
    userId
  )
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
  const accountLoginByInstallation = new Map(
    dbInstallations.map((installation) => [
      installation.id,
      installation.account_login,
    ])
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
        listUserGitHubInstallations(userId, installationIds),
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
        repos: [
          dbRowToWire(
            exactRow,
            accountLoginByInstallation.get(exactRow.installation_id)
          ),
        ],
        page: 1,
        perPage,
        hasMore: false,
        installUrl,
      })
    }

    // DB miss — try live API per installation.
    const liveInstallations = await listUserGitHubInstallations(
      userId,
      installationIds
    )
    for (const inst of liveInstallations) {
      try {
        const repo = await ghProvider.getRepo(String(inst.id), search)
        return c.json({
          repos: [
            {
              ...repo,
              accountLogin: inst.accountLogin,
              installationId: String(inst.id),
            },
          ],
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
    repos: rows.map((row) =>
      dbRowToWire(row, accountLoginByInstallation.get(row.installation_id))
    ),
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

githubRouter.post("/installations/sync", githubWriteScope, async (c) => {
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
    const organizationId =
      c.req.query("organizationId") ?? c.req.query("projectId")
    const scope = await getOrganizationScope(c, user.id)
    if (organizationId && !scope) {
      return c.json({ error: "organization_not_found" }, 404)
    }
    allowedIds = await getAccessibleGitHubInstallationIds(user.id, scope?.id)
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
// Returns cache status for every persisted installation to instance admins, and
// only user-linked installations to members.
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 10 * 60 * 1000

githubRouter.get("/installations/cache-status", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  let installationIds: string[]
  try {
    const organizationId =
      c.req.query("organizationId") ?? c.req.query("projectId")
    const scope = await getOrganizationScope(c, userId)
    if (organizationId && !scope) {
      return c.json({ error: "organization_not_found" }, 404)
    }
    installationIds = scope
      ? await listGitHubInstallationIdsForOrganizationAndUser(db, scope.id, userId)
      : (await isInstanceAdmin(db, userId))
        ? (await listInstallations(db, "github")).map((row) => row.external_id)
        : await getUserGitHubInstallationIds(userId)
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
  if (!hasOrganizationQuery(c)) {
    return c.json({ error: "organization_required" }, 400)
  }
  const owner = c.req.param("owner")
  const repo = c.req.param("repo")
  const fullName = `${owner}/${repo}`

  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  const organization = await getOrganizationScope(c, userId)
  if (!organization) return c.json({ error: "organization_not_found" }, 404)
  const installationIds = await listGitHubInstallationIdsForOrganizationAndUser(
    db,
    organization.id,
    userId
  )
  const installations = await listUserGitHubInstallations(
    userId,
    installationIds
  )
  if (installations.length === 0) {
    // The repo picker is served from the cached repo table, so it stays
    // populated after an installation is revoked on GitHub. Without this flag
    // the wizard would report "no branches" for a repo that simply is not
    // reachable any more.
    return c.json({
      branches: [],
      needsInstall: true,
      installUrl: getInstallationStartUrl(organization.id),
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
  if (!hasOrganizationQuery(c)) {
    return c.json({ error: "organization_required" }, 400)
  }
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

  const organization = await getOrganizationScope(c, userId)
  if (!organization) return c.json({ error: "organization_not_found" }, 404)
  const installationIds = await listGitHubInstallationIdsForOrganizationAndUser(
    db,
    organization.id,
    userId
  )
  const installations = await listUserGitHubInstallations(
    userId,
    installationIds
  )
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
  if (!hasOrganizationQuery(c)) {
    return c.json({ error: "organization_required" }, 400)
  }
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

  const organization = await getOrganizationScope(c, userId)
  if (!organization) return c.json({ error: "organization_not_found" }, 404)
  const installationIds = await listGitHubInstallationIdsForOrganizationAndUser(
    db,
    organization.id,
    userId
  )
  const installations = await listUserGitHubInstallations(
    userId,
    installationIds
  )
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
  if (!hasOrganizationQuery(c)) {
    return c.json({ error: "organization_required" }, 400)
  }
  const ref = c.req.query("ref")?.trim()
  if (!ref) return c.json({ error: "missing_ref" }, 400)
  const owner = c.req.param("owner")
  const fullName = `${owner}/${c.req.param("repo")}`
  if (!(await getGitHubAppConfig(db)))
    return c.json({ error: "github_app_not_configured" }, 503)
  const organization = await getOrganizationScope(c, userId)
  if (!organization) return c.json({ error: "organization_not_found" }, 404)
  const installationIds = await listGitHubInstallationIdsForOrganizationAndUser(
    db,
    organization.id,
    userId
  )
  const installations = preferredInstallations(
    await listUserGitHubInstallations(userId, installationIds),
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
  if (!hasOrganizationQuery(c)) {
    return c.json({ error: "organization_required" }, 400)
  }
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

  const organization = await getOrganizationScope(c, userId)
  if (!organization) return c.json({ error: "organization_not_found" }, 404)
  const installationIds = await listGitHubInstallationIdsForOrganizationAndUser(
    db,
    organization.id,
    userId
  )
  const installations = await listUserGitHubInstallations(
    userId,
    installationIds
  )
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
  if (!hasOrganizationQuery(c)) {
    return c.json({ error: "organization_required" }, 400)
  }
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

  const organization = await getOrganizationScope(c, userId)
  if (!organization) return c.json({ error: "organization_not_found" }, 404)
  const installationIds = await listGitHubInstallationIdsForOrganizationAndUser(
    db,
    organization.id,
    userId
  )
  const installations = await listUserGitHubInstallations(
    userId,
    installationIds
  )
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
// Organization members see that organization's grants plus their own personal
// installation. Owners may claim a trusted organization installation linked to
// them in another workspace; webhook-only installations require a fresh signed
// install flow and are never catalogued here.
// ---------------------------------------------------------------------------

githubRouter.get("/installations", async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: "unauthenticated" }, 401)
  const config = await getGitHubAppConfig(db)
  if (!config) {
    return c.json({ error: "github_app_not_configured" }, 503)
  }

  try {
    const scope = await getScopedGitHubInstallationIds(c, userId)
    if (hasOrganizationQuery(c) && !scope.organization) {
      return c.json({ error: "organization_not_found" }, 404)
    }
    // Read the persisted snapshot once. GitHub discovery and repo refreshes run
    // through webhooks, reconnect and the sync worker, never during page loads.
    const isAdmin =
      !hasOrganizationQuery(c) && (await isInstanceAdmin(db, userId))
    const trustedIds =
      scope.organization?.role === "owner"
        ? await getUserGitHubInstallationIds(userId)
        : []
    const visibleIds = new Set(scope.installationIds)
    const snapshotIds = [...new Set([...scope.installationIds, ...trustedIds])]
    const rows = await listInstallations(
      db,
      "github",
      isAdmin ? undefined : snapshotIds.map(getGitHubInstallationDbId)
    )
    const organizationGrantIds = scope.organization
      ? new Set(
          await listGitHubInstallationIdsForOrganization(db, scope.organization.id)
        )
      : null
    const installations = rows.filter(
      (row) => isAdmin || visibleIds.has(row.external_id)
    )
    const trustedIdSet = new Set(trustedIds)
    const claimableInstallations = rows.filter(
      (row) =>
        row.account_type === "Organization" &&
        trustedIdSet.has(row.external_id) &&
        !visibleIds.has(row.external_id)
    )
    const counts = new Map(
      (
        await getCacheStatus(db, "github", installations.map((row) => row.id))
      ).map((row) => [row.id, row.repoCount])
    )
    const toWire = (row: (typeof rows)[number], includeRepoCount = true) => ({
      id: Number(row.external_id),
      ...(row.github_app_id ? { githubAppId: row.github_app_id } : {}),
      accountLogin: row.account_login,
      accountType: row.account_type ?? "",
      repositorySelection:
        row.repository_selection === "all" ? "all" : "selected",
      suspendedAt: row.suspended_at?.toISOString() ?? null,
      htmlUrl: row.html_url ?? "",
      avatarUrl: row.avatar_url ?? "",
      repositoryCount: includeRepoCount ? (counts.get(row.id) ?? 0) : null,
    })
    return c.json({
      installations: installations.map((installation) => ({
        ...toWire(installation),
        ...(organizationGrantIds
          ? { granted: organizationGrantIds.has(installation.external_id) }
          : {}),
      })),
      ...(scope.organization?.role === "owner"
        ? {
            claimableInstallations: claimableInstallations.map((row) =>
              toWire(row, false)
            ),
          }
        : {}),
      installUrl: getInstallationStartUrl(scope.organization?.id),
      installTargets: getInstallTargets(
        await listGitHubAppConfigs(db),
        scope.organization?.id
      ),
    })
  } catch (err) {
    log.error({ err }, "list persisted GitHub installations failed")
    return c.json({ error: "github_api_error", detail: String(err) }, 502)
  }
})

// ---------------------------------------------------------------------------
// GET /github/installations/start  (organization owner required)
// The signed state binds the owner and organization for revalidation in the
// public callback. The final callback performs a GitHub user authorization
// check before creating the organization grant.
// ---------------------------------------------------------------------------

githubRouter.get("/installations/start", githubWriteScope, githubOwnerSession, async (c) => {
  const user = c.get("user")
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401)
  }
  const organizationId =
    c.req.query("organizationId") ?? c.req.query("projectId")
  const claimInstallationId = c.req.query("installationId")
    ? normalizeGitHubInstallationId(c.req.query("installationId"))
    : null
  if (c.req.query("installationId") && !claimInstallationId) {
    return c.json({ error: "invalid_installation_id" }, 400)
  }
  if (organizationId) {
    const scope = await requireOrganizationOwner(c, user.id)
    if (!scope || scope.id !== organizationId) {
      return c.json({ error: "organization_owner_required" }, 403)
    }
  } else if (!(await isInstanceAdmin(db, user.id))) {
    // Compatibility for old instance-admin settings clients. New workspace
    // flows always carry organizationId and take the owner path above.
    return c.json({ error: "admin_required" }, 403)
  }

  const returnTo = sanitizeReturnTo(
    c.req.query("return_to"),
    GITHUB_RETURN_FALLBACK
  )
  const resolved = await resolveInstallApp(c.req.query("appId"))
  if (!resolved.app) {
    if (resolved.error === "github_app_required") {
      return c.redirect(
        buildReturnUrl(
          returnTo,
          new URLSearchParams({ install_error: resolved.error })
        ),
        302
      )
    }
    return c.json({ error: resolved.error }, 503)
  }
  const config = resolved.app
  const state = crypto.randomUUID()
  c.header(
    "Set-Cookie",
    buildCookieStr(
      INSTALL_STATE_COOKIE,
      signInstallState(
        state,
        user.id,
        returnTo,
        organizationId,
        claimInstallationId ?? undefined,
        config.id
      ),
      APP_STATE_TTL_SECONDS,
      true
    )
  )
  return c.redirect(buildInstallStartUrl(config.slug, state), 302)
})

for (const method of ["get", "post"] as const) {
  githubRouter[method](
    "/installations/:id/claim",
    githubWriteScope,
    githubOwnerSession,
    async (c) => {
      const user = c.get("user")
      if (!user) return c.json({ error: "unauthenticated" }, 401)
      const installationId = normalizeGitHubInstallationId(c.req.param("id"))
      if (!installationId)
        return c.json({ error: "invalid_installation_id" }, 400)
      const body =
        method === "post"
          ? ((await c.req.json().catch(() => null)) as {
              organizationId?: unknown
              projectId?: unknown
              returnTo?: unknown
            } | null)
          : null
      const organizationId =
        c.req.query("organizationId") ??
        c.req.query("projectId") ??
        (typeof body?.organizationId === "string"
          ? body.organizationId
          : typeof body?.projectId === "string"
            ? body.projectId
            : undefined)
      if (!organizationId) {
        return c.json({ error: "organization_required" }, 400)
      }
      const scope = await requireOrganizationOwner(c, user.id)
      if (!scope || scope.id !== organizationId) {
        return c.json({ error: "organization_owner_required" }, 403)
      }
      const config =
        (await getGitHubAppConfigForInstallation(db, installationId)) ??
        (c.req.query("appId")
          ? await getGitHubAppConfig(db, c.req.query("appId"))
          : null)
      if (!config) return c.json({ error: "github_app_not_configured" }, 503)
      const returnTo = sanitizeReturnTo(
        c.req.query("return_to") ?? body?.returnTo,
        GITHUB_RETURN_FALLBACK
      )
      const state = crypto.randomUUID()
      c.header(
        "Set-Cookie",
        buildCookieStr(
          INSTALL_STATE_COOKIE,
          signInstallState(
            state,
            user.id,
            returnTo,
            organizationId,
            installationId,
            config.id
          ),
          APP_STATE_TTL_SECONDS,
          true
        )
      )
      return c.redirect(buildInstallStartUrl(config.slug, state), 302)
    }
  )
}

// Rebuilds the local user links after a database or encryption-key reset.
// GitHub's App API is the source of truth here: only installations currently
// returned for this exact App are linked, and only an instance admin may run
// the reconciliation.
githubRouter.post("/installations/reconnect", githubWriteScope, async (c) => {
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

githubRouter.delete("/installations/:id/grant", githubWriteScope, githubOwnerSession, async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "unauthenticated" }, 401)
  const installationId = normalizeGitHubInstallationId(c.req.param("id"))
  if (!installationId) return c.json({ error: "invalid_installation_id" }, 400)
  const organizationId =
    c.req.query("organizationId") ?? c.req.query("projectId")
  if (!organizationId) return c.json({ error: "organization_required" }, 400)
  const scope = await requireOrganizationOwner(c, user.id)
  if (!scope || scope.id !== organizationId) {
    return c.json({ error: "organization_owner_required" }, 403)
  }
  const removed = await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db
    const removed = await revokeGitHubInstallationFromOrganization(
      transactionDb,
      organizationId,
      installationId
    )
    if (!removed) return false
    await writeGitHubInstallationAudit(transactionDb, {
      action: "github.installation.revoked",
      organizationId,
      installationId,
      actorUserId: user.id,
    })
    return true
  })
  return c.json({ ok: true, revoked: removed, installationId })
})

githubRouter.delete("/installations/:id", githubWriteScope, async (c) => {
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
    const normalizedInstallationId =
      normalizeGitHubInstallationId(installationId)
    if (!normalizedInstallationId) {
      params.set("install_error", "missing_installation_id")
    } else if (installState?.organizationId) {
      const actorUserId = installState.userId
      const ownerStillExists = await organizationOwnerStillExists(
        installState.organizationId,
        actorUserId
      )
      if (!ownerStillExists) {
        params.set("install_error", "organization_owner_required")
      } else if (
        installState.claimInstallationId &&
        installState.claimInstallationId !== normalizedInstallationId
      ) {
        params.set("install_error", "installation_mismatch")
      } else {
        const config = installState.githubAppId
          ? await getGitHubAppConfig(db, installState.githubAppId)
          : await getGitHubAppConfigForInstallation(
              db,
              normalizedInstallationId
            )
        if (!config) {
          params.set("install_error", "github_app_not_configured")
        } else {
          const oauthState = crypto.randomUUID()
          c.header(
            "Set-Cookie",
            buildCookieStr(
              INSTALL_OAUTH_STATE_COOKIE,
              signInstallOAuthState({
                state: oauthState,
                githubAppId: config.id,
                userId: actorUserId,
                organizationId: installState.organizationId,
                installationId: normalizedInstallationId,
                claimInstallationId: installState.claimInstallationId,
                setupAction: setupAction ?? null,
                returnTo,
                issuedAt: Date.now(),
              }),
              APP_STATE_TTL_SECONDS,
              true
            ),
            { append: true }
          )
          return c.redirect(
            buildInstallOAuthUrl(config.client_id, oauthState),
            302
          )
        }
      }
    } else {
      const requestedByIsAdmin = requestedBy
        ? await isInstanceAdmin(db, requestedBy)
        : false
      if (!requestedByIsAdmin) {
        params.set("install_error", "admin_required")
      } else {
        const actorUserId = requestedBy as string
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

githubRouter.post("/app/manifest", githubWriteScope, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    return_to?: unknown
    organization?: unknown
  } | null
  const returnTo = sanitizeReturnTo(body?.return_to, GITHUB_RETURN_FALLBACK)
  // A private App is installable only on its owner, so an App for a GitHub
  // organization must be registered under that organization.
  const organization =
    typeof body?.organization === "string" ? body.organization.trim() : ""
  if (organization && !GITHUB_LOGIN_PATTERN.test(organization)) {
    return c.json({ error: "invalid_github_organization" }, 400)
  }
  const state = crypto.randomUUID()

  // Build self URL (scheme + host from request or env fallback)
  const selfUrl = env.GITHUB_APP_CALLBACK_URL
    ? new URL(env.GITHUB_APP_CALLBACK_URL).origin
    : `http://localhost:${env.PORT}`

  const manifest = buildManifest({
    webBaseUrl: env.WEB_ORIGIN,
    apiBaseUrl: selfUrl,
    ...(organization ? { ownerLogin: organization } : {}),
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
    post_url: organization
      ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new?state=${state}`
      : `https://github.com/settings/apps/new?state=${state}`,
  })
})

// ---------------------------------------------------------------------------
// POST /github/app/import  (auth required)
// Reconnects a GitHub App that already exists on github.com after a local DB
// reset. The installation may already exist; this endpoint restores the App
// credentials needed to sign JWTs, then kicks a global sync.
// ---------------------------------------------------------------------------

githubRouter.post("/app/import", githubWriteScope, async (c) => {
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

  let verifiedApp: {
    id: number
    client_id: string
    slug: string
    name: string
    owner?: { login: string; type: string } | null | undefined
  }
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
        owner: z
          .object({ login: z.string(), type: z.string() })
          .nullish(),
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

  const githubAppId = await saveGitHubAppConfig(db, {
    app_id: parsed.data.appId,
    client_id: parsed.data.clientId,
    slug: verifiedApp.slug,
    name: verifiedApp.name,
    ...(verifiedApp.owner
      ? {
          owner_login: verifiedApp.owner.login,
          owner_type: verifiedApp.owner.type,
        }
      : {}),
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
    id: githubAppId,
    name: verifiedApp.name,
    slug: verifiedApp.slug,
    app_id: parsed.data.appId,
    install_url: getInstallationStartUrl(undefined, githubAppId),
  })
})

// ---------------------------------------------------------------------------
// GET /github/app/callback?code=&state=  (public — GitHub redirects here)
// ---------------------------------------------------------------------------

githubRouter.get("/app/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state")

  // Installation grants use the same callback URL as the manifest flow so
  // existing GitHub App registrations keep working. The dedicated cookie
  // makes the two flows unambiguous and carries no bearer token.
  const cookieHeader = c.req.raw.headers.get("cookie") ?? ""
  const rawInstallOAuthState = parseCookie(
    cookieHeader,
    INSTALL_OAUTH_STATE_COOKIE
  )
  if (rawInstallOAuthState) {
    c.header("Set-Cookie", clearCookieStr(INSTALL_OAUTH_STATE_COOKIE))
    if (!code || !state) {
      return c.json({ error: "missing_code_or_state" }, 400)
    }
    const oauthState = verifyInstallOAuthState(rawInstallOAuthState, state)
    if (!oauthState) {
      return c.json({ error: "state_mismatch" }, 400)
    }

    const config = await getGitHubAppConfig(db, oauthState.githubAppId)
    if (!config) {
      return c.redirect(
        buildReturnUrl(
          oauthState.returnTo,
          new URLSearchParams({ install_error: "github_app_not_configured" })
        ),
        302
      )
    }

    let proof: GitHubUserInstallationProof
    try {
      proof = await exchangeGitHubUserInstallations(code, config)
    } catch (err) {
      log.warn({ err }, "github installation owner proof failed")
      return c.redirect(
        buildReturnUrl(
          oauthState.returnTo,
          new URLSearchParams({ install_error: "claim_authority_missing" })
        ),
        302
      )
    }

    const installation = proof.installations.find(
      (candidate) => String(candidate.id) === oauthState.installationId
    )
    let organizationMembership: Awaited<
      ReturnType<typeof verifyGitHubOrganizationAdmin>
    > = "verified"
    if (installation?.accountType === "Organization") {
      try {
        organizationMembership = await verifyGitHubOrganizationAdmin(
          proof.accessToken,
          installation.accountLogin,
          proof.login
        )
      } catch (err) {
        log.warn(
          { err, accountLogin: installation.accountLogin },
          "github organization membership proof failed"
        )
        return c.redirect(
          buildReturnUrl(
            oauthState.returnTo,
            new URLSearchParams({
              install_error: "github_org_membership_unverified",
            })
          ),
          302
        )
      }
    }
    if (
      !installation ||
      !["Organization", "User"].includes(installation.accountType) ||
      (installation.accountType === "User" &&
        installation.accountLogin.toLowerCase() !==
          proof.login.toLowerCase()) ||
      !(await organizationOwnerStillExists(
        oauthState.organizationId,
        oauthState.userId
      ))
    ) {
      return c.redirect(
        buildReturnUrl(
          oauthState.returnTo,
          new URLSearchParams({ install_error: "claim_authority_missing" })
        ),
        302
      )
    }
    if (organizationMembership === "permission_missing") {
      return c.redirect(
        buildReturnUrl(
          oauthState.returnTo,
          new URLSearchParams({
            install_error: "github_members_permission_required",
          })
        ),
        302
      )
    }
    if (organizationMembership !== "verified") {
      return c.redirect(
        buildReturnUrl(
          oauthState.returnTo,
          new URLSearchParams({
            install_error: "github_org_membership_unverified",
          })
        ),
        302
      )
    }

    const now = new Date()
    const syncId = nanoid()
    try {
      const committed = await db.transaction(async (tx) => {
        const transactionDb = tx as unknown as typeof db
        const currentConfig = await lockGitHubAppConfigForUse(
          transactionDb,
          config.id
        )
        if (!currentConfig || !isSameStoredGitHubApp(config, currentConfig)) {
          return false
        }
        await upsertInstallation(transactionDb, {
          id: getGitHubInstallationDbId(oauthState.installationId),
          github_app_id: config.id,
          provider: "github",
          external_id: oauthState.installationId,
          account_login: installation.accountLogin,
          account_type: installation.accountType,
          repository_selection: installation.repositorySelection,
          suspended_at: installation.suspendedAt
            ? new Date(installation.suspendedAt)
            : null,
          html_url: installation.htmlUrl,
          avatar_url: installation.avatarUrl,
          repository_count: null,
          last_synced_at: now,
          created_at: now,
        })
        await assignGitHubInstallationToUser(
          transactionDb,
          oauthState.installationId,
          oauthState.userId
        )
        await grantGitHubInstallationToOrganization(
          transactionDb,
          oauthState.organizationId,
          oauthState.installationId,
          oauthState.userId
        )
        if (oauthState.claimInstallationId) {
          await writeGitHubInstallationAudit(transactionDb, {
            action: "github.installation.claimed",
            organizationId: oauthState.organizationId,
            installationId: oauthState.installationId,
            actorUserId: oauthState.userId,
          })
        }
        await writeGitHubInstallationAudit(transactionDb, {
          action: "github.installation.granted",
          organizationId: oauthState.organizationId,
          installationId: oauthState.installationId,
          actorUserId: oauthState.userId,
        })
        return true
      })
      if (!committed) {
        return c.redirect(
          buildReturnUrl(
            oauthState.returnTo,
            new URLSearchParams({ install_error: "github_app_changed" })
          ),
          302
        )
      }
      await markGitHubInstallationSyncPending({
        installationId: oauthState.installationId,
        actorUserId: oauthState.userId,
        source: "api",
      })
      await enqueueProviderReposSync({
        provider: "github",
        installationId: oauthState.installationId,
        requestedBy: oauthState.userId,
        syncId,
      })
    } catch (err) {
      log.error(
        { err, installationId: oauthState.installationId, syncId },
        "github installation grant callback failed"
      )
      return c.redirect(
        buildReturnUrl(
          oauthState.returnTo,
          new URLSearchParams({ install_error: "sync_failed" })
        ),
        302
      )
    }

    const params = new URLSearchParams({
      installation_id: oauthState.installationId,
      ...(oauthState.setupAction
        ? { setup_action: oauthState.setupAction }
        : {}),
      installed: "1",
      sync_id: syncId,
    })
    return c.redirect(buildReturnUrl(oauthState.returnTo, params), 302)
  }

  if (!code || !state) {
    return c.json({ error: "missing_code_or_state" }, 400)
  }

  // Verify CSRF state cookie
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
    owner?: { login?: string; type?: string } | null
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
    owner_login: data.owner?.login ?? null,
    owner_type: data.owner?.type ?? null,
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
  const apps = await listGitHubAppConfigs(db)
  const first = apps[0]
  if (!first) {
    return c.json({ configured: false, apps: [] })
  }
  return c.json({
    configured: true,
    name: first.name,
    slug: first.slug,
    app_id: first.app_id,
    install_url: getInstallationStartUrl(
      undefined,
      apps.length > 1 ? first.id : undefined
    ),
    apps: apps.map((app) => ({
      id: app.id,
      name: app.name,
      slug: app.slug,
      app_id: app.app_id,
      owner_login: app.owner_login,
      owner_type: app.owner_type,
      install_url: getInstallationStartUrl(undefined, app.id),
    })),
  })
})

// ---------------------------------------------------------------------------
// GET /github/app/organization-lookup?login=  (instance admin only)
// GitHub lists no organization to a private App before it is installed there,
// and private memberships are hidden from public listings, so the admin types
// the login. This confirms it is an existing organization before registering.
// ---------------------------------------------------------------------------

githubRouter.get("/app/organization-lookup", async (c) => {
  const login = c.req.query("login")?.trim() ?? ""
  if (!GITHUB_LOGIN_PATTERN.test(login)) {
    return c.json({ error: "invalid_github_organization" }, 400)
  }
  let res: Response
  try {
    res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(login)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ploydok",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    log.warn({ err, login }, "github organization lookup failed")
    return c.json({ error: "github_api_error" }, 502)
  }
  if (res.status === 404) {
    return c.json({ error: "github_organization_not_found" }, 404)
  }
  if (!res.ok) return c.json({ error: "github_api_error" }, 502)
  const org = (await res.json()) as {
    login?: unknown
    name?: unknown
    avatar_url?: unknown
  }
  const taken = (await listGitHubAppConfigs(db)).some(
    (app) => app.owner_login?.toLowerCase() === login.toLowerCase()
  )
  return c.json({
    login: typeof org.login === "string" ? org.login : login,
    name: typeof org.name === "string" ? org.name : null,
    avatarUrl: typeof org.avatar_url === "string" ? org.avatar_url : "",
    hasApp: taken,
  })
})

/**
 * Resolves the App targeted by an admin action: `?appId=` when given, else the
 * only App. Several Apps without an explicit id is ambiguous and refused.
 */
async function resolveAdminApp(c: {
  req: { query: (name: string) => string | undefined }
}): Promise<
  | { app: GitHubAppRow | null; ambiguous?: never }
  | { app?: never; ambiguous: true }
> {
  const appId = c.req.query("appId")
  if (appId) return { app: await getGitHubAppConfig(db, appId) }
  const apps = await listGitHubAppConfigs(db)
  if (apps.length > 1) return { ambiguous: true }
  return { app: apps[0] ?? null }
}

const GITHUB_APP_REQUIRED_ERROR = {
  error: {
    code: "GITHUB_APP_REQUIRED",
    message: "Several GitHub Apps are configured. Pass appId to choose one.",
  },
}

// ---------------------------------------------------------------------------
// GET /github/app/credentials/status  (instance admin only)
// ---------------------------------------------------------------------------

githubRouter.get("/app/credentials/status", async (c) => {
  const apps = await listGitHubAppConfigs(db)
  if (apps.length === 0) {
    return c.json({ status: "not_configured" as const })
  }

  const unreadable: string[] = []
  for (const app of apps) {
    try {
      await decryptAppPrivateKey(app)
    } catch (err) {
      if (!(err instanceof GitHubAppCredentialsError)) {
        throw err
      }
      log.warn({ err, githubAppId: app.id }, "github app credentials check failed")
      unreadable.push(app.id)
    }
  }
  if (unreadable.length === 0) {
    return c.json({ status: "readable" as const })
  }
  return c.json({
    status: "unreadable" as const,
    error: {
      code: "GITHUB_APP_CREDENTIALS_UNREADABLE" as const,
      message: GITHUB_APP_CREDENTIALS_UNREADABLE_MESSAGE,
    },
  })
})

// ---------------------------------------------------------------------------
// DELETE /github/app/config/local?appId=  (instance admin only, local recovery)
// ---------------------------------------------------------------------------

githubRouter.delete("/app/config/local", githubWriteScope, async (c) => {
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

  // Without appId every unreadable App is forgotten: a changed MASTER_KEY
  // breaks them all at once. No App left: still clear the GitHub state an
  // earlier reset left behind.
  const appId = c.req.query("appId")
  const appRowIds = appId
    ? [appId]
    : (await listGitHubAppConfigs(db)).map((app) => app.id)
  if (appRowIds.length === 0) appRowIds.push("")

  let reset = false
  for (const appRowId of appRowIds) {
    const forgotten = await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as typeof db
      const config = await lockGitHubAppConfigForReset(transactionDb, appRowId)
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

      await deleteGitHubAppLocalState(transactionDb, appRowId)
      return true
    })
    reset ||= forgotten
  }
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
// DELETE /github/app/config?appId=  (auth required, destructive admin reset)
// ---------------------------------------------------------------------------

githubRouter.delete("/app/config", githubWriteScope, async (c) => {
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

  const target = await resolveAdminApp(c)
  if (target.ambiguous) return c.json(GITHUB_APP_REQUIRED_ERROR, 400)
  const config = target.app
  if (!config) {
    return c.json({ ok: true, uninstalled: 0 })
  }

  let installations: Awaited<ReturnType<typeof listAppInstallations>>
  try {
    installations = await listAppInstallations(config)
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
      await revokeAppInstallation(installation.id, config)
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
    const currentConfig = await lockGitHubAppConfigForReset(
      transactionDb,
      config.id
    )
    if (currentConfig && !isSameStoredGitHubApp(config, currentConfig)) {
      return false
    }
    await deleteGitHubAppLocalState(transactionDb, config.id)
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
  const apps = await listGitHubAppConfigs(db)
  if (apps.length === 0) {
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

  // GitHub names the sending App in this header. It is unauthenticated, so it
  // only orders the candidates; the HMAC still decides which App signed.
  const targetAppId = c.req.header("x-github-hook-installation-target-id")
  const targeted = targetAppId
    ? await getGitHubAppConfigByAppId(db, targetAppId)
    : null
  const candidates = targeted
    ? [targeted, ...apps.filter((app) => app.id !== targeted.id)]
    : apps

  // Empty secret = App created without a webhook (manifest without
  // hook_attributes, typical of loopback dev setups).
  let signingApp: GitHubAppRow | null = null
  let anyWebhookSecret = false
  for (const app of candidates) {
    const webhookSecret = await decryptField(
      app.webhook_secret_enc as Buffer,
      app.webhook_secret_nonce as Buffer
    )
    if (webhookSecret.length === 0) continue
    anyWebhookSecret = true
    if (verifySignature(body, signature, webhookSecret)) {
      signingApp = app
      break
    }
  }

  if (!anyWebhookSecret) {
    return c.json({ error: "webhook not configured for this GitHub App" }, 503)
  }

  if (!signingApp) {
    log.warn(
      { signature: signature?.slice(0, 20) },
      "webhook signature rejected"
    )
    return c.json({ error: "invalid signature" }, 401)
  }
  const githubAppId = signingApp.id

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
      { payloadHash, rawBodyBuffer, githubAppId },
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
