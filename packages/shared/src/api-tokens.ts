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
  "storage:read",
  "storage:write",
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

export const MCP_TOKEN_MAX_DAYS = 90

/** Token confined to /mcp and bound to one organization. */
export const McpTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  orgId: z.string().min(1),
  appIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  allowDeploy: z.boolean().default(false),
  expiresInDays: z
    .number()
    .int()
    .positive()
    .max(MCP_TOKEN_MAX_DAYS)
    .default(30),
})

export type McpTokenCreateInput = z.input<typeof McpTokenCreateSchema>

export function mcpTokenScopes(allowDeploy: boolean): ApiTokenScope[] {
  const scopes: ApiTokenScope[] = [
    "apps:read",
    "services:read",
    "databases:read",
  ]
  if (allowDeploy) scopes.push("apps:deploy")
  return scopes
}

export const ApiTokenSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  created_at: z.date(),
  last_used_at: z.date().nullable(),
  expires_at: z.date().nullable(),
  revoked_at: z.date().nullable(),
  kind: z.enum(["api", "mcp"]),
  org_id: z.string().nullable(),
  app_ids: z.array(z.string()).nullable(),
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
