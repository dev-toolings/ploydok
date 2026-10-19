// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from "hono"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { createRedis, type Db } from "@ploydok/db"
import { insertAuditLog } from "@ploydok/db/queries"
import { env } from "../env"
import type { AuthUser } from "../auth/middleware"
import { checkRateLimit } from "../webhooks/rate-limit"
import { createApiCaller } from "./call"
import type { McpAuditEntry } from "./server"
import { createPloydokMcpServer } from "./server"
import { createPolicyStore } from "./policy"
import type { PolicyStore } from "./policy"

export const MCP_ACTIONS_PER_MINUTE = 10

type RequestableApp = Parameters<typeof createApiCaller>[0]

export type McpHandlerDeps = {
  store?: PolicyStore
  allowAction?: (tokenId: string) => Promise<boolean>
  audit?: (user: AuthUser, entry: McpAuditEntry) => Promise<void>
}

/**
 * Streamable HTTP endpoint, stateless: each POST builds a server bound to the
 * calling token. Only `mcp` tokens are accepted, never a browser session.
 */
export function createMcpHandler(
  db: Db,
  app: RequestableApp,
  deps: McpHandlerDeps = {}
) {
  const store = deps.store ?? createPolicyStore(db)
  let redis: ReturnType<typeof createRedis> | undefined
  const allowAction =
    deps.allowAction ??
    (async (tokenId: string) => {
      redis ??= createRedis(env.REDIS_URL)
      const res = await checkRateLimit(
        redis,
        `rl:mcp-actions:${tokenId}`,
        60,
        MCP_ACTIONS_PER_MINUTE
      )
      return res.allowed
    })
  const audit =
    deps.audit ??
    (async (user: AuthUser, entry: McpAuditEntry) => {
      await insertAuditLog(db, {
        user_id: user.id,
        action: "mcp.tool_called",
        target_type: entry.targetType,
        target_id: entry.targetId,
        metadata: JSON.stringify({
          tool: entry.tool,
          token_id: user.pat_id,
          ok: entry.ok,
          ...(entry.code ? { code: entry.code } : {}),
        }),
      })
    })

  return async (c: Context): Promise<Response> => {
    if (c.req.method !== "POST") {
      return c.json(
        {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: "This MCP endpoint is stateless: use POST",
          },
        },
        405,
        { Allow: "POST" }
      )
    }

    const user = c.get("user") as AuthUser | undefined
    if (!user || user.token_kind !== "mcp") {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "An MCP token is required (Authorization: Bearer)",
          },
        },
        401
      )
    }

    const server = createPloydokMcpServer({
      user,
      callApi: createApiCaller(app, c.env as object | undefined, user),
      store,
      allowAction,
      audit: (entry) => audit(user, entry),
    })
    // No sessionIdGenerator: stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw)
    } finally {
      await server.close()
    }
  }
}
