// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

export const ALL_SCOPES = [
  "apps:read",
  "apps:write",
  "apps:deploy",
  "services:read",
  "services:write",
  "secrets:read",
  "secrets:write",
  "databases:read",
  "databases:write",
  "databases:*",
  "admin:*",
] as const

export const ApiTokenScopeSchema = z.enum(ALL_SCOPES)
export type ApiTokenScope = z.infer<typeof ApiTokenScopeSchema>

export const ApiTokenCreateSchema = z.object({
  name: z.string().min(1).max(255),
  expiresInDays: z.number().int().positive().optional(),
  scopes: z.array(ApiTokenScopeSchema).min(1).optional(),
})

export type ApiTokenCreateInput = z.infer<typeof ApiTokenCreateSchema>

export const ApiTokenSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  created_at: z.date(),
  last_used_at: z.date().nullable(),
  expires_at: z.date().nullable(),
  revoked_at: z.date().nullable(),
})

export type ApiTokenSummary = z.infer<typeof ApiTokenSummarySchema>

export const ApiTokenResponseSchema = z.object({
  token: z.string(),
  row: ApiTokenSummarySchema,
})

export type ApiTokenResponse = z.infer<typeof ApiTokenResponseSchema>

/**
 * `admin:*` couvre tout ; `databases:*` couvre toute opération databases ; sinon match exact.
 */
export function tokenHasScope(
  tokenScopes: readonly string[],
  required: string
): boolean {
  if (tokenScopes.includes("admin:*")) return true
  if (tokenScopes.includes(required)) return true
  const [resource] = required.split(":")
  if (resource && tokenScopes.includes(`${resource}:*`)) return true
  return false
}
