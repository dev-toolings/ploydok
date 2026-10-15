// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { Db } from "@ploydok/db"
import { users } from "@ploydok/db"
import { env } from "../env"

// 30 minutes — long enough for a human to spot the URL in logs, short enough
// to bound the exposure window if logs leak.
const TOKEN_TTL_MS = 30 * 60 * 1000

// Borne dupliquée dans scripts/check-stack.ts : `make check` doit refuser un
// token que l'API rejetterait, sinon il affiche une URL qui part en 403.
const MIN_ENV_TOKEN_LENGTH = 16

interface SetupToken {
  value: string
  expires_at: number
  permanent: boolean
}

let current: SetupToken | null = null
let tokenlessBannerPrinted = false

function hasActiveToken(): boolean {
  if (!current) return false
  if (!current.permanent && Date.now() > current.expires_at) {
    current = null
    return false
  }
  return true
}

function newRandom(): string {
  return randomBytes(32).toString("hex")
}

function buildSetupUrl(token: string): string {
  return `${env.WEB_ORIGIN}/setup?token=${token}`
}

export async function bootstrapSetupToken(db: Db): Promise<void> {
  const existing = await db.select({ id: users.id }).from(users).limit(1)
  if (existing.length > 0) return

  if (!env.PLOYDOK_SETUP_TOKEN_REQUIRED) {
    if (!tokenlessBannerPrinted) {
      tokenlessBannerPrinted = true
      // eslint-disable-next-line no-console
      console.warn(
        [
          "",
          "┌─ Ploydok first boot ─────────────────────────────────────────────────────────┐",
          `│ Open: ${env.WEB_ORIGIN}/setup`,
          "│ Create the first admin on that page. The first visitor to submit owns the instance.",
          "└──────────────────────────────────────────────────────────────────────────────┘",
          "",
        ].join("\n")
      )
    }
    return
  }

  if (hasActiveToken()) return

  const presented = Bun.env["PLOYDOK_SETUP_TOKEN"]?.trim()
  if (presented && presented.length < MIN_ENV_TOKEN_LENGTH) {
    // eslint-disable-next-line no-console
    console.warn(
      `[setup-token] PLOYDOK_SETUP_TOKEN is ${presented.length} chars, minimum ${MIN_ENV_TOKEN_LENGTH} — falling back to a generated token`
    )
  }
  const fromEnv =
    presented && presented.length >= MIN_ENV_TOKEN_LENGTH ? presented : null
  const value = fromEnv ?? newRandom()
  current = {
    value,
    expires_at: fromEnv ? Number.POSITIVE_INFINITY : Date.now() + TOKEN_TTL_MS,
    permanent: fromEnv !== null,
  }

  const url = buildSetupUrl(value)
  const expiry = fromEnv
    ? "source: PLOYDOK_SETUP_TOKEN (no expiry)"
    : "expires in 30 min — restart api to regenerate"
  // eslint-disable-next-line no-console
  console.warn(
    [
      "",
      "┌─ Ploydok first boot ─────────────────────────────────────────────────────────┐",
      `│ Open: ${url}`,
      `│ ${expiry}`,
      "└──────────────────────────────────────────────────────────────────────────────┘",
      "",
    ].join("\n")
  )
}

export const SETUP_SESSION_COOKIE = "ploydok_setup"

// Le wizard s'ouvre sur /setup nu. Sans jeton (défaut), le formulaire crée le
// premier admin. Si PLOYDOK_SETUP_TOKEN_REQUIRED=1, hors prod l'API dépose le
// token actif dans un cookie HttpOnly ; en prod il reste à présenter.
export function setupSessionGrantAllowed(): boolean {
  return env.NODE_ENV !== "prod"
}

export function getSetupTokenValue(): string | null {
  return hasActiveToken() ? current!.value : null
}

// Un token permanent (PLOYDOK_SETUP_TOKEN) n'expire pas, mais le cookie qui le
// transporte, si : il ne sert que le temps du wizard.
export function setupSessionMaxAge(): number {
  if (!hasActiveToken()) return 0
  if (current!.permanent) return TOKEN_TTL_MS / 1000
  return Math.max(0, Math.ceil((current!.expires_at - Date.now()) / 1000))
}

export type SetupTokenSource = "env" | "generated"

export function getSetupTokenState(): {
  active: boolean
  expires_at: number | null
  source: SetupTokenSource | null
} {
  if (!hasActiveToken())
    return { active: false, expires_at: null, source: null }
  return {
    active: true,
    expires_at: current!.permanent ? null : current!.expires_at,
    source: current!.permanent ? "env" : "generated",
  }
}

export function validateSetupToken(presented: string | undefined): boolean {
  if (!current || !presented) return false
  if (!current.permanent && Date.now() > current.expires_at) {
    current = null
    return false
  }
  const a = Buffer.from(presented)
  const b = Buffer.from(current.value)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function consumeSetupToken(presented: string | undefined): boolean {
  if (!validateSetupToken(presented)) return false
  current = null
  return true
}

// Called after a successful first-admin creation to make further setup attempts
// 404 even if the original token is intercepted.
export function clearSetupToken(): void {
  current = null
}

// Test-only — never call from production code.
export function __resetSetupTokenForTest(): void {
  current = null
  tokenlessBannerPrinted = false
}
