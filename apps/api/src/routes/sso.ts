// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { z } from "zod"
import { projects, users, memberships } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import {
  getSSOConfigByOrgId,
  createSSOConfig,
  updateSSOConfig,
  deleteSSOConfig,
  hasRole,
} from "@ploydok/db/queries"
import {
  SSOConfigCreateBodySchema,
  SSOConfigUpdateBodySchema,
} from "@ploydok/shared"
import { env } from "../env"
import { requireFeature } from "../billing/feature-gate"
import {
  initOIDCClient,
  generateAuthorizationUrl,
  exchangeCodeForToken,
  testOIDCConfig,
  getDecryptedSSOConfig,
} from "../auth/sso"
import { encryptField, decryptField } from "../github/app-credentials"
import { createSession } from "../auth/sessions"
import { signAccessToken } from "../auth/jwt"
import { childLogger } from "../logger"

const log = childLogger("routes.sso")

type AppEnv = { Variables: { user?: any; session_id?: string } }

function getUser(c: { get: (k: string) => unknown }): any {
  return c.get("user") as any
}

export function createSSORouter(db: Db): Hono<any, any, any> {
  const router = new Hono<AppEnv>()
  const requireSso = requireFeature(db, "sso")

  /**
   * GET /orgs/:slug/sso-configs — Get SSO config (summary, no secret).
   */
  router.get("/orgs/:slug/sso-configs", async (c) => {
    const slug = c.req.param("slug")
    const user = getUser(c)

    if (!user) {
      return c.json({ error: "Unauthenticated" }, 401)
    }

    try {
      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
        .limit(1)

      const project = projectRows[0]
      if (!project) {
        return c.json({ error: "Organization not found" }, 404)
      }

      if (!(await hasRole(db, project.id, user.id, ["owner"]))) {
        return c.json({ error: "Forbidden" }, 403)
      }

      const config = await getSSOConfigByOrgId(db, project.id)
      if (!config) {
        return c.json({ config: null })
      }

      const summary = {
        id: config.id,
        org_id: config.org_id,
        issuer: config.issuer,
        client_id: config.client_id,
        redirect_uri: config.redirect_uri,
        scopes: config.scopes,
        enabled: config.enabled,
        created_at: config.created_at.toISOString(),
        updated_at: config.updated_at.toISOString(),
      }

      return c.json({ config: summary })
    } catch (err) {
      log.error({ slug, error: err }, "Error fetching SSO config")
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  /**
   * POST /orgs/:slug/sso-configs — Create SSO config.
   */
  router.post("/orgs/:slug/sso-configs", requireSso, async (c) => {
    const slug = c.req.param("slug")
    const user = getUser(c)

    if (!user) {
      return c.json({ error: "Unauthenticated" }, 401)
    }

    try {
      const body = await c.req.json()
      const parsed = SSOConfigCreateBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json(
          { error: "Invalid request body", details: parsed.error.flatten() },
          400
        )
      }

      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
        .limit(1)

      const project = projectRows[0]
      if (!project) {
        return c.json({ error: "Organization not found" }, 404)
      }

      if (!(await hasRole(db, project.id, user.id, ["owner"]))) {
        return c.json({ error: "Forbidden" }, 403)
      }

      const existingConfig = await getSSOConfigByOrgId(db, project.id)
      if (existingConfig) {
        return c.json(
          {
            error: "SSO configuration already exists for this organization",
          },
          409
        )
      }

      const { enc, nonce } = await encryptField(parsed.data.client_secret)

      const config = await createSSOConfig(db, {
        id: nanoid(),
        org_id: project.id,
        issuer: parsed.data.issuer,
        client_id: parsed.data.client_id,
        client_secret_enc: enc,
        client_secret_nonce: nonce,
        redirect_uri: parsed.data.redirect_uri,
        scopes: parsed.data.scopes,
        enabled: false,
        created_at: new Date(),
        updated_at: new Date(),
      })

      const summary = {
        id: config.id,
        org_id: config.org_id,
        issuer: config.issuer,
        client_id: config.client_id,
        redirect_uri: config.redirect_uri,
        scopes: config.scopes,
        enabled: config.enabled,
        created_at: config.created_at.toISOString(),
        updated_at: config.updated_at.toISOString(),
      }

      return c.json({ config: summary }, 201)
    } catch (err) {
      log.error({ slug, error: err }, "Error creating SSO config")
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  /**
   * PATCH /orgs/:slug/sso-configs — Update SSO config.
   */
  router.patch("/orgs/:slug/sso-configs", requireSso, async (c) => {
    const slug = c.req.param("slug")
    const user = getUser(c)

    if (!user) {
      return c.json({ error: "Unauthenticated" }, 401)
    }

    try {
      const body = await c.req.json()
      const parsed = SSOConfigUpdateBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json(
          { error: "Invalid request body", details: parsed.error.flatten() },
          400
        )
      }

      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
        .limit(1)

      const project = projectRows[0]
      if (!project) {
        return c.json({ error: "Organization not found" }, 404)
      }

      if (!(await hasRole(db, project.id, user.id, ["owner"]))) {
        return c.json({ error: "Forbidden" }, 403)
      }

      const existingConfig = await getSSOConfigByOrgId(db, project.id)
      if (!existingConfig) {
        return c.json({ error: "SSO configuration not found" }, 404)
      }

      const updates: any = {}
      if (parsed.data.issuer) updates.issuer = parsed.data.issuer
      if (parsed.data.client_id) updates.client_id = parsed.data.client_id
      if (parsed.data.redirect_uri)
        updates.redirect_uri = parsed.data.redirect_uri
      if (parsed.data.scopes) updates.scopes = parsed.data.scopes

      if (parsed.data.client_secret) {
        const { enc, nonce } = await encryptField(parsed.data.client_secret)
        updates.client_secret_enc = enc
        updates.client_secret_nonce = nonce
      }

      const updatedConfig = await updateSSOConfig(db, project.id, updates)
      if (!updatedConfig) {
        return c.json({ error: "Failed to update SSO config" }, 500)
      }

      const summary = {
        id: updatedConfig.id,
        org_id: updatedConfig.org_id,
        issuer: updatedConfig.issuer,
        client_id: updatedConfig.client_id,
        redirect_uri: updatedConfig.redirect_uri,
        scopes: updatedConfig.scopes,
        enabled: updatedConfig.enabled,
        created_at: updatedConfig.created_at.toISOString(),
        updated_at: updatedConfig.updated_at.toISOString(),
      }

      return c.json({ config: summary })
    } catch (err) {
      log.error({ slug, error: err }, "Error updating SSO config")
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  /**
   * DELETE /orgs/:slug/sso-configs — Delete SSO config.
   */
  router.delete("/orgs/:slug/sso-configs", requireSso, async (c) => {
    const slug = c.req.param("slug")
    const user = getUser(c)

    if (!user) {
      return c.json({ error: "Unauthenticated" }, 401)
    }

    try {
      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
        .limit(1)

      const project = projectRows[0]
      if (!project) {
        return c.json({ error: "Organization not found" }, 404)
      }

      if (!(await hasRole(db, project.id, user.id, ["owner"]))) {
        return c.json({ error: "Forbidden" }, 403)
      }

      await deleteSSOConfig(db, project.id)
      return c.json({ ok: true })
    } catch (err) {
      log.error({ slug, error: err }, "Error deleting SSO config")
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  /**
   * POST /orgs/:slug/sso-configs/test — Test OIDC connection.
   */
  router.post("/orgs/:slug/sso-configs/test", requireSso, async (c) => {
    const slug = c.req.param("slug")
    const user = getUser(c)

    if (!user) {
      return c.json({ error: "Unauthenticated" }, 401)
    }

    try {
      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
        .limit(1)

      const project = projectRows[0]
      if (!project) {
        return c.json({ error: "Organization not found" }, 404)
      }

      if (!(await hasRole(db, project.id, user.id, ["owner"]))) {
        return c.json({ error: "Forbidden" }, 403)
      }

      const config = await getSSOConfigByOrgId(db, project.id)
      if (!config) {
        return c.json({ error: "SSO configuration not found" }, 404)
      }

      const clientSecretDec = await decryptField(
        config.client_secret_enc,
        config.client_secret_nonce
      )

      const result = await testOIDCConfig(
        config.issuer,
        config.client_id,
        clientSecretDec,
        config.redirect_uri
      )

      return c.json(result)
    } catch (err) {
      log.error({ slug, error: err }, "Error testing SSO config")
      return c.json({ ok: false, error: "Internal server error" }, 500)
    }
  })

  /**
   * GET /auth/sso/:orgSlug/login — Redirect to OIDC auth URL.
   */
  router.get("/auth/sso/:orgSlug/login", async (c) => {
    const orgSlug = c.req.param("orgSlug")

    try {
      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, orgSlug))
        .limit(1)

      const project = projectRows[0]
      if (!project) {
        return c.json({ error: "Organization not found" }, 404)
      }

      const ssoConfig = await getDecryptedSSOConfig(db, project.id)
      if (!ssoConfig) {
        return c.json(
          {
            error: "SSO is not configured or enabled for this organization",
          },
          400
        )
      }

      const client = await initOIDCClient(
        ssoConfig.issuer,
        ssoConfig.clientId,
        ssoConfig.clientSecretDec,
        ssoConfig.redirectUri
      )
      if (!client) {
        return c.json({ error: "Failed to initialize OIDC client" }, 500)
      }

      const { authUrl, codeVerifier, state } = generateAuthorizationUrl(
        client,
        ssoConfig.scopes
      )

      const cookieValue = JSON.stringify({ codeVerifier, state })
      c.header(
        "Set-Cookie",
        `ploydok_sso_state=${encodeURIComponent(cookieValue)}; Path=/; Max-Age=300; HttpOnly; SameSite=Lax`
      )

      return c.redirect(authUrl)
    } catch (err) {
      log.error({ orgSlug, error: err }, "Error generating SSO auth URL")
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  /**
   * GET /auth/sso/:orgSlug/callback — OIDC callback.
   */
  router.get("/auth/sso/:orgSlug/callback", async (c) => {
    const orgSlug = c.req.param("orgSlug")
    const code = c.req.query("code")
    const state = c.req.query("state")

    try {
      if (!code || !state) {
        return c.json({ error: "Missing code or state parameter" }, 400)
      }

      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, orgSlug))
        .limit(1)

      const project = projectRows[0]
      if (!project) {
        return c.json({ error: "Organization not found" }, 404)
      }

      const cookieHeader = c.req.raw.headers.get("cookie") ?? ""
      const cookies: Record<string, string> = {}
      for (const part of cookieHeader.split(";")) {
        const idx = part.indexOf("=")
        if (idx === -1) continue
        const k = part.slice(0, idx).trim()
        const v = part.slice(idx + 1).trim()
        cookies[k] = decodeURIComponent(v)
      }

      const ssoStateCookie = cookies["ploydok_sso_state"]
      if (!ssoStateCookie) {
        return c.json({ error: "Missing SSO state cookie" }, 400)
      }

      const { state: savedState, codeVerifier } = JSON.parse(ssoStateCookie)
      if (state !== savedState) {
        return c.json({ error: "State mismatch" }, 400)
      }

      const ssoConfig = await getDecryptedSSOConfig(db, project.id)
      if (!ssoConfig) {
        return c.json(
          {
            error: "SSO is not configured or enabled for this organization",
          },
          400
        )
      }

      const client = await initOIDCClient(
        ssoConfig.issuer,
        ssoConfig.clientId,
        ssoConfig.clientSecretDec,
        ssoConfig.redirectUri
      )
      if (!client) {
        return c.json({ error: "Failed to initialize OIDC client" }, 500)
      }

      const tokenResult = await exchangeCodeForToken(client, code, codeVerifier)
      const userEmail = tokenResult.email

      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.email, userEmail))
        .limit(1)

      let user = userRows[0]
      if (!user) {
        return c.json(
          {
            error:
              "User not a member of this organization. Ask the owner to invite you.",
          },
          403
        )
      }

      const membershipRows = await db
        .select()
        .from(memberships)
        .where(eq(memberships.user_id, user.id))
        .limit(1)

      const membership = membershipRows[0]
      if (!membership || membership.org_id !== project.id) {
        return c.json(
          {
            error:
              "User not a member of this organization. Ask the owner to invite you.",
          },
          403
        )
      }

      const userAgent = c.req.raw.headers.get("user-agent") ?? ""
      const ipHeader = c.req.raw.headers.get("x-forwarded-for") ?? ""
      const ip = ipHeader
        ? (ipHeader.split(",")[0] ?? "unknown").trim()
        : "unknown"

      const sessionResult = await createSession(db, {
        userId: user.id,
        userAgent,
        ip,
      })

      const accessToken = await signAccessToken({
        userId: user.id,
        email: user.email,
        sessionId: sessionResult.sessionId,
      })

      c.header(
        "Set-Cookie",
        `ploydok_access=${encodeURIComponent(accessToken)}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`
      )
      c.header(
        "Set-Cookie",
        `ploydok_refresh=${encodeURIComponent(sessionResult.refreshToken)}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax`
      )

      return c.redirect(`${env.WEB_ORIGIN}/orgs/${orgSlug}/dashboard`)
    } catch (err) {
      log.error({ orgSlug, error: err }, "Error in SSO callback")
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  return router
}
