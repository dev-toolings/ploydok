// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "crypto"
import bcrypt from "bcryptjs"
import { Hono } from "hono"
import type { Db } from "@ploydok/db"
import {
  createToken,
  listTokensForUser,
  revokeToken,
} from "@ploydok/db/queries"
import { ApiTokenCreateSchema } from "@ploydok/shared"
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
    }

    return c.json({ token, row: summary }, 201)
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
