// SPDX-License-Identifier: AGPL-3.0-only
import type { Context, Next } from "hono"
import { eq } from "drizzle-orm"
import { users, passkeys, totp_secrets, sessions } from "@ploydok/db"
import { verifyAccessToken, ACCESS_COOKIE } from "./jwt"
import { countActive } from "./backup-codes"
import type { Db } from "@ploydok/db"
import { authenticatePat } from "./pat"
import { getMcpPrincipal } from "./mcp-principal"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCookies(cookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    out[k] = decodeURIComponent(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// Types stored in context
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string
  email: string
  display_name: string
  session_id: string
  /**
   * Scopes accordés par le PAT utilisé. Absent ⇒ session cookie classique
   * (équivaut à `["admin:*"]` côté checks de scope).
   */
  token_scopes?: string[]
  /**
   * id du PAT utilisé (présent uniquement si l'auth vient d'un Bearer plk_/ploy_).
   */
  pat_id?: string
  /** `mcp` tokens authenticate only on /mcp, bound to `token_org_id`. */
  token_kind?: "api" | "mcp"
  token_org_id?: string
  /** Undefined = every app of `token_org_id`. */
  token_app_ids?: string[]
}

// Hono context variable types
export interface AppVariables {
  user: AuthUser
  session_id: string
  access_exp: number
  /**
   * Organization (project) id resolved by `requireRole` from the `:slug` or
   * `:orgId` route param. Set only after `requireRole` runs, so downstream
   * handlers reuse it instead of re-resolving the slug.
   */
  org_id: string
  /**
   * Membership role of the current user in `org_id`, as validated by
   * `requireRole`. `"owner" | "member"` in v1.
   */
  membership_role: "owner" | "member"
}

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

/**
 * Reads the ploydok_access cookie, verifies the JWT, loads the user from DB,
 * and attaches it to c.set('user', ...) and c.set('session_id', ...).
 *
 * Returns 401 if missing, expired, or tampered.
 */
export function requireAuth(db: Db) {
  return async (c: Context, next: Next) => {
    const mcpPrincipal = getMcpPrincipal(c)
    if (mcpPrincipal) {
      c.set("user", mcpPrincipal)
      c.set("session_id", mcpPrincipal.session_id)
      c.set("access_exp", 0)
      return next()
    }

    const patResult = await authenticatePat(c, db)
    if (patResult.kind === "invalid") {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Invalid API token",
          },
        },
        401
      )
    }

    if (patResult.kind === "ok") {
      c.set("user", patResult.user)
      c.set("session_id", patResult.user.session_id)
      c.set("access_exp", 0)
      return next()
    }

    const cookieHeader = c.req.raw.headers.get("cookie") ?? ""
    const cookies = parseCookies(cookieHeader)
    const token = cookies[ACCESS_COOKIE]

    if (!token) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        },
        401
      )
    }

    let payload
    try {
      payload = await verifyAccessToken(token)
    } catch {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Invalid or expired token",
          },
        },
        401
      )
    }

    const userId = payload.sub
    const sessionId = payload.session_id
    if (!userId || !sessionId) {
      return c.json(
        {
          error: { code: "UNAUTHENTICATED", message: "Invalid token payload" },
        },
        401
      )
    }

    // Query every cookie-auth request so logout/session revocation takes effect immediately.
    const sessionRows = await db
      .select({
        id: sessions.id,
        user_id: sessions.user_id,
        revoked_at: sessions.revoked_at,
        expires_at: sessions.expires_at,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)

    const session = sessionRows[0]
    if (
      !session ||
      session.user_id !== userId ||
      session.revoked_at !== null ||
      session.expires_at <= new Date()
    ) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Session expired or revoked",
          },
        },
        401
      )
    }

    // Load user from DB
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    const user = rows[0]
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHENTICATED", message: "User not found" } },
        401
      )
    }

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      session_id: payload.session_id,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("user", authUser)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("session_id", payload.session_id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set(
      "access_exp",
      typeof payload.exp === "number" ? payload.exp : 0
    )

    return next()
  }
}

// ---------------------------------------------------------------------------
// requireSecondFactor
// ---------------------------------------------------------------------------

/**
 * Must be called after requireAuth.
 * Blocks with 403 SECOND_FACTOR_REQUIRED if user has:
 * - fewer than 2 passkeys, AND
 * - 0 non-consumed backup codes.
 */
export function requireSecondFactor(db: Db) {
  return async (c: Context, next: Next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = (c as any).get("user") as AuthUser | undefined
    if (!user) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        },
        401
      )
    }

    // Count passkeys
    const passkeyRows = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.user_id, user.id))

    const passkeyCount = passkeyRows.length
    const backupCount = await countActive(db, user.id)

    // Check TOTP verified
    const totpRows = await db
      .select({ verified_at: totp_secrets.verified_at })
      .from(totp_secrets)
      .where(eq(totp_secrets.user_id, user.id))
      .limit(1)
    const hasTotp = Boolean(totpRows[0]?.verified_at)

    if (passkeyCount >= 2 || backupCount >= 1 || hasTotp) {
      return next()
    }

    return c.json(
      {
        error: {
          code: "SECOND_FACTOR_REQUIRED",
          message: "A second factor is required",
        },
      },
      403
    )
  }
}

// ---------------------------------------------------------------------------
// requireRole — extracted to ./require-role to keep this module's import chain
// out of route files. Re-exported here for backward compatibility.
// ---------------------------------------------------------------------------

export { requireRole } from "./require-role"
