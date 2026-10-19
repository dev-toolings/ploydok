// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "crypto"
import bcrypt from "bcryptjs"
import type { Context, Next } from "hono"
import type { Db } from "@ploydok/db"
import { audit_log } from "@ploydok/db"
import {
  getActiveToken,
  updateTokenLastUsed,
  getUser,
} from "@ploydok/db/queries"
import { childLogger } from "../logger"
import type { AuthUser } from "./middleware"

const log = childLogger("pat")

export const MCP_PATH = "/mcp"

export type PatAuthResult =
  | { kind: "not_applicable" }
  | { kind: "invalid" }
  | { kind: "ok"; user: AuthUser }

function readPatBearerToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization")
  if (!authHeader?.startsWith("Bearer ")) return null

  const token = authHeader.slice(7)
  if (!token.startsWith("ploy_") && !token.startsWith("plk_live_")) {
    return null
  }

  return token
}

export async function authenticatePat(
  c: Context,
  db: Db
): Promise<PatAuthResult> {
  const token = readPatBearerToken(c)
  if (!token) return { kind: "not_applicable" }

  const hash = createHash("sha256").update(token).digest("hex")
  const activeToken = await getActiveToken(db, hash)

  // Si bcrypt_hash présent (token créé Vague 2+), exige verify constant-time.
  // Sinon (legacy), le lookup SHA-256 unique-index suffit.
  let verified = !!activeToken
  if (activeToken && activeToken.bcrypt_hash) {
    verified = await bcrypt.compare(token, activeToken.bcrypt_hash)
  }

  if (!activeToken || !verified) {
    return { kind: "invalid" }
  }

  // MCP tokens carry their org/app allowlist, which only the /mcp tool layer
  // enforces: anywhere else they would act as unrestricted user tokens.
  if (activeToken.kind === "mcp" && c.req.path !== MCP_PATH) {
    return { kind: "invalid" }
  }

  const user = await getUser(db, activeToken.user_id)
  if (!user) {
    return { kind: "invalid" }
  }

  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    session_id: activeToken.id,
    token_scopes: activeToken.scopes ?? ["admin:*"],
    pat_id: activeToken.id,
    token_kind: activeToken.kind,
    ...(activeToken.org_id ? { token_org_id: activeToken.org_id } : {}),
    ...(activeToken.app_ids ? { token_app_ids: activeToken.app_ids } : {}),
  }

  await updateTokenLastUsed(db, activeToken.id, new Date())

  // Audit log par appel — best-effort, ne bloque jamais la requête.
  try {
    await db.insert(audit_log).values({
      user_id: user.id,
      action: "api_token.used",
      target_type: "api_token",
      target_id: activeToken.id,
      metadata: JSON.stringify({
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        scopes: activeToken.scopes ?? ["admin:*"],
      }),
      created_at: new Date(),
    })
  } catch (err) {
    log.warn(
      { err: (err as Error).message, token_id: activeToken.id },
      "audit_log.insert_failed"
    )
  }

  return { kind: "ok", user: authUser }
}

/**
 * Middleware Bearer pour Personal Access Tokens.
 *
 * Accepte les formats `ploy_<base64url>` (legacy) et `plk_live_<base64url>`
 * (nouveau pattern documenté DoD Sprint 6.5-bis). Le hash stocké est SHA-256
 * du token complet — on calcule donc le hash sans tenir compte du préfixe.
 *
 * Si le token est valide :
 *  - injecte `user` dans le contexte (avec `token_scopes` + `pat_id`)
 *  - met à jour `last_used_at`
 *  - écrit une entrée audit log `api_token.used`
 */
export async function patAuthMiddleware(
  c: Context,
  next: Next,
  db: Db
): Promise<void> {
  const result = await authenticatePat(c, db)
  if (result.kind === "ok") {
    c.set("user", result.user)
  }

  await next()
}
