// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from "hono"
import type { AuthUser } from "./middleware"

/**
 * In-process channel used by MCP tools to run existing REST routes as the
 * already authenticated token. The key is a module-private symbol stored in
 * the Hono env, which Bun builds server-side (`createApiFetch`): a network
 * request cannot set it.
 */
const MCP_PRINCIPAL = Symbol("ploydok.mcpPrincipal")

export type McpPrincipalEnv = { [MCP_PRINCIPAL]: AuthUser }

export function withMcpPrincipal<E extends object>(
  env: E | undefined,
  user: AuthUser
): E & McpPrincipalEnv {
  return { ...(env ?? ({} as E)), [MCP_PRINCIPAL]: user }
}

export function getMcpPrincipal(c: Context): AuthUser | undefined {
  const env = c.env as Partial<McpPrincipalEnv> | undefined
  return env?.[MCP_PRINCIPAL]
}
