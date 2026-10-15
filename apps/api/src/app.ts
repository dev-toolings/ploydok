// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { cors } from "hono/cors"
import { nanoid } from "nanoid"
import { eq } from "drizzle-orm"
import type { Context, Next } from "hono"
import { env } from "./env"
import { createDb } from "@ploydok/db"
import { users, passkeys, totp_secrets } from "@ploydok/db"
import { createAuthRouter } from "./routes/auth"
import { shouldUseSecureCookies } from "./auth/jwt"
import { requireAuth, type AuthUser } from "./auth/middleware"
import { createApiTokensRouter } from "./routes/api-tokens"
import { countActive } from "./auth/backup-codes"
import { createDebugRouter } from "./debug/index.js"
import { getSharedAgent, getSharedCaddy } from "./debug/singletons.js"
import { AgentError, GrpcStatus } from "./agent/index.js"
import { childLogger } from "./logger"
import { appsRouter } from "./routes/apps"
import { appsEnvRouter } from "./routes/apps-env"
import { createAppsScansRouter } from "./routes/apps-scans"
import { appsDomainsRouter } from "./routes/apps-domains"
import { appsVolumesRouter } from "./routes/apps-volumes"
import { createCdnRouter } from "./routes/apps-cdn"
import { createPreviewsRoute } from "./routes/apps-previews"
import { githubRouter } from "./routes/github"
import { gitlabRouter } from "./routes/gitlab"
import { createGitProvidersRouter } from "./routes/git-providers"
import { registryCredentialsRouter } from "./routes/registry-credentials"
import { wsRouter } from "./routes/ws"
import { wsExecRouter } from "./routes/apps-exec"
import { appsFilesRouter } from "./routes/apps-files"
import { eventsRouter } from "./routes/events"
import { monitoringRouter, startMonitoringLoop } from "./routes/monitoring"
import { notificationsRouter } from "./routes/notifications"
import { secretsRouter } from "./routes/secrets"
import { createDatabasesRouter } from "./routes/databases"
import { createAdminerRouter } from "./routes/adminer"
import { createBackupsRouter } from "./routes/backups"
import { createStorageDestinationsRouter } from "./routes/storage-destinations"
import { createAppsDatabasesLinkRouter } from "./routes/apps-databases-link"
import { appsProtectionRouter } from "./routes/apps-protection"
import { createOrganizationsRouter } from "./routes/organizations"
import { createOrganizationDeploymentsRouter } from "./routes/organization-deployments"
import { createMembershipsRouter } from "./routes/memberships"
import { createInvitationsRouter } from "./routes/invitations"
import { createServicesRouter } from "./routes/services"
import { createMarketplaceRouter } from "./routes/marketplace"
import { auditRouter } from "./routes/audit"
import { createBillingRouter } from "./routes/billing"
import { createStripeWebhookRouter } from "./routes/webhooks-stripe"
import { createSSORouter } from "./routes/sso"
import { createBrandingRouter } from "./routes/branding"
import { createEventWebhooksRouter } from "./routes/event-webhooks"
import { createScheduledJobsRouter } from "./routes/scheduled-jobs"
import { createProjectEnvRouter } from "./routes/project-env"
import { createOrgMonitoringRouter } from "./routes/org-monitoring"
import { createHostStatsRouter } from "./routes/host-stats"
import { createDiskRouter } from "./routes/disk"
import { createAdvisoriesRouter } from "./routes/advisories"
import { auditPubkeyRouter } from "./routes/audit-pubkey"
import { getDefaultOrganizationForUser } from "./services/organizations"
import {
  collectProcessMetrics,
  httpRequestsTotal,
  renderMetrics,
} from "./observability/metrics"
import { collectOperationalMetrics } from "./observability/operational-metrics"
import { buildHealthReport, buildPublicStatus } from "./observability/health"
import { createOpenApiDocument } from "./openapi"
import { isStripeWebhookRequest } from "./security/csrf-exemptions"
import {
  invitationOwnerRateLimit,
  invitationRegisterRateLimit,
} from "./security/invitations-rate-limit"

const httpLog = childLogger("http")
const errorLog = childLogger("error")

// ---------------------------------------------------------------------------
// CI-only auth bypass
//
// SECURITY: This bypass is ONLY active when ALL of these conditions are met:
//   1. NODE_ENV is NOT "prod"
//   2. PLOYDOK_DEBUG_UNAUTHENTICATED=1 is set
//
// In production, this code path is unreachable — the guard below ensures it.
// Used exclusively for integration tests in CI where no real user session
// is available. Never ship this to a production environment.
// ---------------------------------------------------------------------------

const CI_AUTH_BYPASS =
  env.NODE_ENV !== "prod" && Bun.env["PLOYDOK_DEBUG_UNAUTHENTICATED"] === "1"

/**
 * Injects a fake AuthUser into the Hono context when CI_AUTH_BYPASS is active.
 * The fake user id is taken from X-Test-User header (defaults to "ci-test-user").
 *
 * This middleware replaces both requireAuth AND the CSRF check for /debug/* routes
 * during integration testing. It is skipped entirely in production.
 */
function ciBypassAuth(c: Context, next: Next) {
  const userId = c.req.header("x-test-user") ?? "ci-test-user"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(c as any).set("user", {
    id: userId,
    email: "ci@test.local",
    display_name: "CI Test User",
    session_id: "ci-session",
  } satisfies AuthUser)
  return next()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

// ---------------------------------------------------------------------------
// DB instance (singleton for the app)
// ---------------------------------------------------------------------------

const db = createDb(env.DATABASE_URL)

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type AppVariables = { reqId: string; user?: AuthUser }
export const app = new Hono<{ Variables: AppVariables }>()

// 1. Logger middleware global — loggue toutes les requêtes, même en cas de throw.
//    Injecte un req_id pour corréler logs + réponse (header `x-request-id`).
app.use("*", async (c, next) => {
  const start = Date.now()
  const incoming = c.req.raw.headers.get("x-request-id")
  const reqId = incoming && incoming.length <= 64 ? incoming : nanoid(12)
  c.set("reqId", reqId)

  try {
    await next()
  } finally {
    const dur = Date.now() - start
    const status = c.res.status
    c.res.headers.set("x-request-id", reqId)
    httpRequestsTotal.inc({
      method: c.req.method,
      status: String(status),
    })

    // Skip les preflights CORS et probes santé/métriques pour limiter le bruit.
    if (
      c.req.method === "OPTIONS" ||
      c.req.path === "/health" ||
      c.req.path === "/health/ready" ||
      c.req.path === "/metrics" ||
      c.req.path === "/status"
    )
      return

    const msg = `${c.req.method} ${c.req.path} ${status} ${dur}ms`
    const meta = { req_id: reqId }
    if (status >= 500) httpLog.error(meta, msg)
    else if (status >= 400) httpLog.warn(meta, msg)
    else httpLog.info(meta, msg)
  }
})

// 2. CORS strict
app.use(
  "*",
  cors({
    // Autorise WEB_ORIGIN en CORS standard et les requêtes same-origin / SSR
    // sans header Origin (TanStack Start server fetch) — jamais de wildcard.
    origin: (origin) => {
      if (!origin) return env.WEB_ORIGIN
      return origin === env.WEB_ORIGIN ? origin : null
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    // upgrade-insecure-requests : un contexte navigateur portant la directive
    // CSP du même nom l'ajoute à CHAQUE fetch, préflight compris. Absent de
    // cette liste, tout appel API échouait en ERR_FAILED derrière une CSP
    // durcie. Le header ne porte aucune capacité — sa valeur est toujours "1".
    allowHeaders: [
      "content-type",
      "x-csrf-token",
      "x-totp-code",
      "upgrade-insecure-requests",
    ],
  })
)

// 3. CSRF double-submit token (skip safe methods and the csrf-issue route)
// In CI (PLOYDOK_DEBUG_UNAUTHENTICATED=1, non-prod), CSRF is bypassed for /debug/* routes.
app.use("*", async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) {
    return next()
  }

  // CI bypass: skip CSRF check for debug routes when auth bypass is active.
  // SECURITY: CI_AUTH_BYPASS is false in production (NODE_ENV === "prod").
  if (CI_AUTH_BYPASS && c.req.path.startsWith("/debug/")) {
    return next()
  }

  // /auth/refresh est protégé par le cookie refresh HttpOnly (non lisible par JS,
  // donc inutilisable en CSRF). Pas de double-submit requis ici — évite les
  // races entre GET /auth/csrf (set cookie) et POST /auth/refresh qui suivent.
  if (c.req.path === "/auth/refresh") {
    return next()
  }

  // /github/webhook est signé HMAC-SHA256 par GitHub — GitHub ne peut pas
  // envoyer le double-submit token. L'authenticité est garantie par la signature.
  if (c.req.path === "/github/webhook") {
    return next()
  }

  // Stripe signs the raw request body and cannot attach the browser-only
  // double-submit token. Keep this exemption exact; the route independently
  // rejects missing or invalid Stripe signatures.
  if (isStripeWebhookRequest(c.req.method, c.req.path)) {
    return next()
  }

  // /gitlab/webhook est authentifié par `X-Gitlab-Token` (shared secret) et
  // /gitlab/callback est un redirect OAuth (depuis gitlab.com) — aucun des
  // deux ne peut attacher le double-submit token.
  if (c.req.path === "/gitlab/webhook" || c.req.path === "/gitlab/callback") {
    return next()
  }

  // /auth/dev-login is gated hard by NODE_ENV !== "prod" inside the handler
  // and by a loopback-Origin check. No CSRF cookie exists yet at first call.
  if (c.req.path === "/auth/dev-login" && env.NODE_ENV !== "prod") {
    return next()
  }

  // /auth/backup-codes/consume est un endpoint de login (aucune session active,
  // donc aucun cookie CSRF à first visit). La sécurité repose sur : Origin check
  // du middleware CORS en amont, rate-limit, et le secret du backup code lui-même.
  // Cohérent avec /auth/dev-login.
  if (c.req.path === "/auth/backup-codes/consume") {
    return next()
  }

  if (c.req.path === "/auth/login/password") {
    return next()
  }

  // Adminer is proxied through a high-entropy, authenticated, short-lived
  // session URL. Adminer forms cannot attach Ploydok's double-submit CSRF
  // header, so CSRF is enforced at session creation instead.
  if (c.req.path.startsWith("/adminer/sessions/")) {
    return next()
  }

  // /auth/setup/* est le first-boot wizard. Aucune session active, pas de
  // cookie CSRF possible. La sécurité repose sur : token éphémère printé dans
  // les logs API + Origin check + count(users)===0 anti-replay.
  if (
    c.req.path === "/auth/setup/password" ||
    c.req.path === "/auth/setup/options" ||
    c.req.path === "/auth/setup/verify"
  ) {
    return next()
  }

  const cookieCsrf = getCookieValue(
    c.req.raw.headers.get("cookie") ?? "",
    "csrf"
  )
  const headerCsrf = c.req.raw.headers.get("x-csrf-token")

  if (!cookieCsrf || !headerCsrf || cookieCsrf !== headerCsrf) {
    return c.json(
      {
        error: {
          code: "CSRF_MISMATCH",
          message: "Invalid or missing CSRF token",
        },
      },
      403
    )
  }

  return next()
})

// 4. Global error handler — attrape toute exception non capturée.
app.onError((err, c) => {
  const reqId = c.get("reqId") ?? "unknown"
  // HTTPException de Hono porte son propre status — on le respecte.
  const status = err instanceof HTTPException ? err.status : 500
  const code =
    (err as { code?: string }).code ??
    (err instanceof HTTPException ? "HTTP_EXCEPTION" : "INTERNAL_ERROR")
  const message =
    env.NODE_ENV === "prod" && status >= 500
      ? "An unexpected error occurred"
      : err.message

  errorLog.error(
    {
      err,
      req_id: reqId,
      path: c.req.path,
      method: c.req.method,
      status,
      code,
    },
    "unhandled error"
  )

  return c.json({ error: { code, message, req_id: reqId } }, status)
})

// 5. Not found handler explicite pour consistence.
app.notFound((c) => {
  const reqId = c.get("reqId") ?? "unknown"
  return c.json(
    {
      error: { code: "NOT_FOUND", message: "Route introuvable", req_id: reqId },
    },
    404
  )
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const PLATFORM_VERSION = Bun.env["PLOYDOK_BUILD_VERSION"] ?? "0.0.1"

// Liveness — répond 200 dès que le process est up. Convention K8s.
app.get("/health", (c) => c.json({ ok: true, version: PLATFORM_VERSION }))

// Readiness — DB + agent socket + Caddy admin. 200 si OK, 503 si dégradé.
app.get("/health/ready", async (c) => {
  const report = await buildHealthReport(db, PLATFORM_VERSION)
  return c.json(report, report.ok ? 200 : 503)
})

// Status page minimaliste publique (pas d'auth) — agrégé up/down.
app.get("/status", async (c) => {
  const report = await buildPublicStatus(db, PLATFORM_VERSION)
  return c.json(report)
})

// Endpoint Prometheus — gated par token admin (PLOYDOK_METRICS_TOKEN).
// Si la var n'est pas définie, l'endpoint est inaccessible (403 systématique)
// pour éviter une fuite de métriques en environnement non-configuré.
app.get("/metrics", async (c) => {
  const expected = Bun.env["PLOYDOK_METRICS_TOKEN"]
  if (!expected) {
    return c.json(
      { error: "metrics endpoint disabled (set PLOYDOK_METRICS_TOKEN)" },
      403
    )
  }
  const auth = c.req.header("Authorization")
  if (auth !== `Bearer ${expected}`) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  collectProcessMetrics()
  await collectOperationalMetrics(db)
  c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  return c.body(renderMetrics())
})

// Generated from the Hono route registry so docs and API stay in sync.
app.get("/openapi.json", (c) => c.json(createOpenApiDocument(app.routes)))

// Test-only routes pour exercer le middleware logger + error handler.
// SECURITY: actifs UNIQUEMENT si NODE_ENV=test.
if (env.NODE_ENV === "test") {
  app.get("/__test/throw", () => {
    throw new Error("boom")
  })
  app.get("/__test/http-exception", () => {
    throw new HTTPException(418, { message: "I'm a teapot" })
  })
}

// CSRF token issuance — GET so it bypasses the CSRF middleware above
app.get("/auth/csrf", (c) => {
  const token = crypto.randomUUID()
  // httpOnly: false is intentional for the double-submit pattern —
  // JavaScript must be able to read the cookie to attach it as a header.
  const secure = shouldUseSecureCookies() ? "; Secure" : ""
  c.header("Set-Cookie", `csrf=${token}; Path=/; SameSite=Lax${secure}`)
  return c.json({ token })
})

// Auth routes (replaces stubs)
const authRouter = createAuthRouter(db)
app.route("/", authRouter)

// Debug routes (spawn-nginx, etc.)
// In CI (PLOYDOK_DEBUG_UNAUTHENTICATED=1, non-prod), auth is bypassed via a fake user.
// SECURITY: CI_AUTH_BYPASS is false in production (NODE_ENV === "prod").
const debugRouter = createDebugRouter()
app.use("/debug/*", CI_AUTH_BYPASS ? ciBypassAuth : requireAuth(db))
app.route("/debug", debugRouter)

// API tokens — all endpoints require auth.
app.use("/api-tokens", requireAuth(db))
app.use("/api-tokens/*", requireAuth(db))
app.route("/api-tokens", createApiTokensRouter(db))

// Host VPS stats (Sprint 6.6) — auth requise.
app.use("/host-stats", requireAuth(db))
app.use("/host-stats/*", requireAuth(db))
app.route("/host-stats", createHostStatsRouter(db))

// Host disk usage & reclaim — auth enforced here; instance-admin gate lives in the router.
app.use("/disk", requireAuth(db))
app.use("/disk/*", requireAuth(db))
app.route("/disk", createDiskRouter(db))

// Apps routes — auth enforced per-endpoint inside the router.
// Order matters: specific sub-routers (env, domains) are mounted before
// the main appsRouter to avoid path shadowing on `/:id`.
app.use("/apps/*", requireAuth(db))
app.route("/apps", appsEnvRouter)
app.route("/apps", createAppsScansRouter(db))
app.route("/apps", appsDomainsRouter)
app.route("/apps", appsVolumesRouter)
app.route("/apps", appsProtectionRouter)
app.route("/apps", createCdnRouter(db))
app.route("/apps", appsRouter)

// GitHub App routes — auth enforced here; instance-admin gate lives in the router.
// /github/app/callback is public (GitHub redirects here after manifest flow).
// /github/webhook is public (signed by GitHub HMAC — CSRF exempted above).
// Legacy OAuth routes are 410 Gone — stubs, no auth required.
app.use("/github/repos/*", requireAuth(db))
app.use("/github/app/manifest", requireAuth(db))
app.use("/github/app/import", requireAuth(db))
app.use("/github/app/config", requireAuth(db))
app.use("/github/app/config/local", requireAuth(db))
app.use("/github/app/credentials/status", requireAuth(db))
app.use("/github/app/organization-lookup", requireAuth(db))
app.use("/github/installations", requireAuth(db))
app.use("/github/installations/*", requireAuth(db))
app.route("/github", githubRouter)

// GitLab provider routes — auth enforced per-endpoint.
// /gitlab/webhook and /gitlab/callback are public (see CSRF exemptions above).
app.use("/gitlab/config", requireAuth(db))
app.use("/gitlab/connect", requireAuth(db))
// OAuth callback still needs the browser session to bind encrypted tokens to
// the user who initiated the authorization flow.
app.use("/gitlab/callback", requireAuth(db))
app.use("/gitlab/repos", requireAuth(db))
app.use("/gitlab/repos/*", requireAuth(db))
app.route("/gitlab", gitlabRouter)

// Per-user, non-secret Git provider onboarding state.
app.use("/git-providers/status", requireAuth(db))
app.route("/git-providers", createGitProvidersRouter(db))

// Registry credentials — all endpoints require auth.
app.use("/registry/credentials", requireAuth(db))
app.use("/registry/credentials/*", requireAuth(db))
app.route("/registry/credentials", registryCredentialsRouter)

// WebSocket upgrade routes — auth is cookie-based, verified inside the handler.
app.route("/ws", wsRouter)
app.route("/ws", wsExecRouter)

// Container file browser — read-only, owner-gated. Mounted alongside /apps so
// /apps/:id/files{,/content} sit next to the shell endpoint.
app.route("/", appsFilesRouter)

app.use("/events", requireAuth(db))
app.use("/events/*", requireAuth(db))
app.route("/events", eventsRouter)

app.use("/monitoring/*", requireAuth(db))
app.route("/monitoring", monitoringRouter)
// Launch the monitoring diff loop only outside of test runs to avoid spurious timers.
if (env.NODE_ENV !== "test") {
  startMonitoringLoop(db)
}

// Notifications channels — all endpoints require auth.
app.use("/notifications/*", requireAuth(db))
app.route("/notifications", notificationsRouter)

// Audit — all endpoints require auth.
app.use("/audit", requireAuth(db))
app.use("/audit/*", requireAuth(db))
app.route("/audit", auditRouter)

// Secrets — all endpoints require auth. Mounted before /apps to avoid shadowing.
app.use("/apps/*/secrets*", requireAuth(db))
app.route("/apps", secretsRouter)

// Databases — all endpoints require auth.
app.use("/databases/*", requireAuth(db))
app.use("/databases", requireAuth(db))
app.route("/databases", createDatabasesRouter(db))

// Adminer proxy — all requests require the normal Ploydok session plus a
// short-lived Adminer session bound to the same user.
app.use("/adminer/*", requireAuth(db))
app.route("/adminer", createAdminerRouter())

// Organizations / workspaces — all endpoints require auth.
app.use("/organizations/*", requireAuth(db))
app.use("/organizations", requireAuth(db))
app.route("/organizations", createOrganizationDeploymentsRouter(db))
app.route("/organizations", createOrganizationsRouter(db))

// Memberships — all endpoints require auth.
app.use("/orgs/*", requireAuth(db))
app.use("/orgs/:orgId/members/invite", invitationOwnerRateLimit)
app.route("/orgs", createMembershipsRouter(db))

// Invitations — preview/register are public; acceptance requires the session
// whose verified account email matches the invitation.
app.use("/invitations/register", invitationRegisterRateLimit)
app.use("/invitations/accept", requireAuth(db))
app.route("/invitations", createInvitationsRouter(db))

// Services (marketplace) — all endpoints require auth.
app.use("/services/*", requireAuth(db))
app.use("/services", requireAuth(db))
app.route("/services", createServicesRouter(db))

// Marketplace catalog (proxied upstream registry) — all endpoints require auth.
app.use("/marketplace/*", requireAuth(db))
app.route("/marketplace", createMarketplaceRouter())

// Backups — all endpoints require auth.
app.use("/databases/*/backups*", requireAuth(db))
app.use("/databases/*/backup-config*", requireAuth(db))
app.use("/databases/*/backup-now*", requireAuth(db))
app.use("/databases/*/restore*", requireAuth(db))
app.use("/backups/*", requireAuth(db))
app.route("/", createBackupsRouter(db))

// Workspace backup destinations: members can inspect; owners can mutate.
app.use("/orgs/*/storage-destinations*", requireAuth(db))
app.route("/orgs", createStorageDestinationsRouter(db))

// Apps ↔ Databases link routes
app.use("/apps/*/databases/*", requireAuth(db))
app.route("/apps", createAppsDatabasesLinkRouter(db))

// Preview deployments — /apps/:id/previews/*
app.use("/apps/*/previews*", requireAuth(db))
app.route("/apps", createPreviewsRoute(db))

// Billing (Stripe) — /orgs/:orgSlug/billing/* requires auth ; webhooks are public + signed.
app.use("/orgs/*/billing/*", requireAuth(db))
const billingOrgScoped = new Hono()
billingOrgScoped.route("/:orgSlug/billing", createBillingRouter(db))
app.route("/orgs", billingOrgScoped)
app.route("/", createStripeWebhookRouter(db))

// SSO (OIDC) — config CRUD requires auth ; /auth/sso/:slug/{login,callback} are public.
app.route("/", createSSORouter(db))

// Branding (whitelabel) — requires auth ; feature-gated at route level.
app.route("/", createBrandingRouter(db))

// Event webhooks (outbound) — /orgs/:orgSlug/event-webhooks/*, requireAuth + owner.
app.use("/orgs/*/event-webhooks/*", requireAuth(db))
app.use("/orgs/*/event-webhooks", requireAuth(db))
const eventWebhooksOrgScoped = new Hono()
eventWebhooksOrgScoped.route(
  "/:orgSlug/event-webhooks",
  createEventWebhooksRouter(db)
)
app.route("/orgs", eventWebhooksOrgScoped)

// Scheduled jobs (cron) — /orgs/:orgSlug/scheduled-jobs/*, requireAuth + owner.
app.use("/orgs/*/scheduled-jobs/*", requireAuth(db))
app.use("/orgs/*/scheduled-jobs", requireAuth(db))
const scheduledJobsOrgScoped = new Hono()
scheduledJobsOrgScoped.route(
  "/:orgSlug/scheduled-jobs",
  createScheduledJobsRouter(db)
)
app.route("/orgs", scheduledJobsOrgScoped)

// Project-level shared env vars — /orgs/:orgSlug/shared-env/*.
app.use("/orgs/*/shared-env/*", requireAuth(db))
app.use("/orgs/*/shared-env", requireAuth(db))
const projectEnvOrgScoped = new Hono()
projectEnvOrgScoped.route("/:orgSlug/shared-env", createProjectEnvRouter(db))
app.route("/orgs", projectEnvOrgScoped)

// Organization-scoped monitoring — all endpoints require auth + org membership.
app.use("/organizations/*/monitoring/*", requireAuth(db))
app.use("/organizations/*/monitoring", requireAuth(db))
app.route("/organizations", createOrgMonitoringRouter(db))

// CVE/advisory scanner — admin platform + app-scoped org endpoints.
app.use("/admin/*", requireAuth(db))
app.use("/organizations/*/apps/*/advisories", requireAuth(db))
app.route("/", createAdvisoriesRouter(db))

// Audit pubkey — public (no auth required)
app.route("/instance", auditPubkeyRouter)

// /me — requires auth
app.get("/me", requireAuth(db), async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (c as any).get("user") as AuthUser
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accessExpiresAt =
    ((c as any).get("access_exp") as number | undefined) ?? 0

  const passkeyRows = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.user_id, user.id))

  const passkeyCount = passkeyRows.length
  const backupCount = await countActive(db, user.id)

  const totpRows = await db
    .select({ verified_at: totp_secrets.verified_at })
    .from(totp_secrets)
    .where(eq(totp_secrets.user_id, user.id))
    .limit(1)
  const hasTotp = Boolean(totpRows[0]?.verified_at)

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  const fullUser = userRows[0]
  if (!fullUser) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "User not found" } },
      404
    )
  }

  const defaultOrganization = await getDefaultOrganizationForUser(
    db,
    fullUser.id,
    fullUser.display_name
  )

  return c.json({
    id: fullUser.id,
    email: fullUser.email,
    display_name: fullUser.display_name,
    created_at: fullUser.created_at?.toISOString(),
    default_organization: defaultOrganization,
    accessExpiresAt,
    has_passkey_plus: passkeyCount >= 2,
    has_backup_codes: backupCount >= 1,
    has_totp: hasTotp,
    require_totp_for_secret_reveal: fullUser.require_totp_for_secret_reveal,
    needs_second_factor: passkeyCount < 2 && backupCount < 1 && !hasTotp,
    is_instance_admin: fullUser.is_instance_admin,
  })
})

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function getCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [k, v] = part.trim().split("=")
    if (k === name && v !== undefined) return decodeURIComponent(v)
  }
  return null
}
