// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "crypto"
import bcrypt from "bcryptjs"
import { Hono } from "hono"
import { and, eq, inArray } from "drizzle-orm"
import { apps } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import {
  createToken,
  hasRole,
  listTokensForUser,
  revokeToken,
} from "@ploydok/db/queries"
import {
  ApiTokenCreateSchema,
  McpTokenCreateSchema,
  mcpTokenScopes,
} from "@ploydok/shared"
import { childLogger } from "../logger"
import type { AuthUser } from "../auth/middleware"
import { userMaxScopes, assertScopesAllowed } from "../auth/scope-rbac"

const log = childLogger("api-tokens.routes")
const BCRYPT_ROUNDS = 10

type AppEnv = { Variables: { user?: AuthUser } }

function getUser(c: { get: (k: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

/**
 * Génère un PAT au format `plk_live_<base64url>` (Sprint 6.5-bis Vague 2).
 * Les anciens tokens `ploy_*` restent acceptés en lecture par le middleware.
 */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const base64url = Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
  return `plk_live_${base64url}`
}

export function createApiTokensRouter(db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.post("/", async (c) => {
    const user = getUser(c)
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    if (user.pat_id !== undefined) {
      return c.json(
        {
          error: {
            code: "PAT_NOT_ALLOWED",
            message: "API tokens cannot manage API tokens",
          },
        },
        403
      )
    }

    const body = await c.req.json()
    const parseResult = ApiTokenCreateSchema.safeParse(body)

    if (!parseResult.success) {
      return c.json({ error: "Invalid request body" }, 400)
    }

    const { name, expiresInDays, scopes: requestedScopes } = parseResult.data

    const maxScopes = await userMaxScopes(db, user.id)
    let scopesToUse = requestedScopes
    if (!scopesToUse) {
      scopesToUse = maxScopes.includes("admin:*") ? ["admin:*"] : ["apps:read"]
    }

    const validation = assertScopesAllowed(scopesToUse, maxScopes)
    if (!validation.ok) {
      return c.json(
        { error: "scope_not_allowed", denied: validation.denied },
        403
      )
    }

    const token = generateToken()
    const tokenHash = createHash("sha256").update(token).digest("hex")
    const bcryptHash = await bcrypt.hash(token, BCRYPT_ROUNDS)

    const tokenParams: {
      userId: string
      name: string
      tokenHash: string
      bcryptHash: string
      expiresAt?: Date
      scopes?: string[]
    } = {
      userId: user.id,
      name,
      tokenHash,
      bcryptHash,
    }

    if (scopesToUse && scopesToUse.length > 0) {
      tokenParams.scopes = scopesToUse
    }

    if (expiresInDays) {
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + expiresInDays)
      tokenParams.expiresAt = expiresAt
    }

    const row = await createToken(db, tokenParams)

    log.info(
      { user_id: user.id, token_id: row.id, scopes: row.scopes },
      "api_token.created"
    )

    const summary = {
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      kind: row.kind,
      org_id: row.org_id,
      app_ids: row.app_ids,
    }

    return c.json({ token, row: summary }, 201)
  })

  router.post("/mcp", async (c) => {
    const user = getUser(c)
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHENTICATED", message: "Unauthorized" } },
        401
      )
    }
    // A token must never mint another token: MCP tokens are issued from an
    // interactive session only.
    if (user.pat_id) {
      return c.json(
        {
          error: {
            code: "PAT_NOT_ALLOWED",
            message: "API tokens cannot create MCP tokens",
          },
        },
        403
      )
    }

    const parsed = McpTokenCreateSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message ?? "Invalid request body",
          },
        },
        400
      )
    }
    const { name, orgId, appIds, allowDeploy, allowConfig, expiresInDays } =
      parsed.data

    const roles: Array<"owner" | "member"> =
      allowDeploy || allowConfig ? ["owner"] : ["owner", "member"]
    if (!(await hasRole(db, orgId, user.id, roles))) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message:
              allowDeploy || allowConfig
                ? "Only organization owners can grant deployments or configuration changes"
                : "Not a member of this organization",
          },
        },
        403
      )
    }

    const uniqueAppIds = appIds ? [...new Set(appIds)] : undefined
    if (uniqueAppIds) {
      const found = await db
        .select({ id: apps.id })
        .from(apps)
        .where(and(eq(apps.project_id, orgId), inArray(apps.id, uniqueAppIds)))
      if (found.length !== uniqueAppIds.length) {
        return c.json(
          {
            error: {
              code: "APP_NOT_IN_ORG",
              message: "Every app must belong to the organization",
            },
          },
          400
        )
      }
    }

    const token = generateToken()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + expiresInDays)
    const row = await createToken(db, {
      userId: user.id,
      name,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      bcryptHash: await bcrypt.hash(token, BCRYPT_ROUNDS),
      expiresAt,
      scopes: mcpTokenScopes(allowDeploy, allowConfig),
      kind: "mcp",
      orgId,
      ...(uniqueAppIds ? { appIds: uniqueAppIds } : {}),
    })

    log.info(
      { user_id: user.id, token_id: row.id, org_id: orgId, scopes: row.scopes },
      "api_token.mcp_created"
    )

    return c.json(
      {
        token,
        row: {
          id: row.id,
          name: row.name,
          scopes: row.scopes,
          created_at: row.created_at,
          last_used_at: row.last_used_at,
          expires_at: row.expires_at,
          revoked_at: row.revoked_at,
          kind: row.kind,
          org_id: row.org_id,
          app_ids: row.app_ids,
        },
      },
      201
    )
  })

  router.get("/", async (c) => {
    const user = getUser(c)
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const tokens = await listTokensForUser(db, user.id)

    return c.json({ tokens })
  })

  router.delete("/:id", async (c) => {
    const user = getUser(c)
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    if (user.pat_id !== undefined) {
      return c.json(
        {
          error: {
            code: "PAT_NOT_ALLOWED",
            message: "API tokens cannot manage API tokens",
          },
        },
        403
      )
    }

    const tokenId = c.req.param("id")

    await revokeToken(db, user.id, tokenId)

    log.info({ user_id: user.id, token_id: tokenId }, "api_token.revoked")

    return c.json({ success: true })
  })

  return router
}
