// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AuthUser } from "../auth/middleware"
import type { ApiRequest, ApiResult } from "./call"
import type { PolicyStore } from "./policy"
import { createPloydokMcpServer } from "./server"

const ORG = "org_1"

function mcpUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "user_1",
    email: "dev@example.com",
    display_name: "Dev",
    session_id: "tok_1",
    pat_id: "tok_1",
    token_kind: "mcp",
    token_org_id: ORG,
    token_scopes: ["apps:read", "services:read", "databases:read"],
    ...overrides,
  }
}

const store: PolicyStore = {
  resourceOrgId: async (_kind, id) => (id.startsWith("other") ? "org_2" : ORG),
  orgSlug: async () => "acme",
}

async function connect(
  user: AuthUser,
  opts: { allowAction?: boolean; reply?: ApiResult } = {}
) {
  const calls: ApiRequest[] = []
  const server = createPloydokMcpServer({
    user,
    store,
    callApi: async (req) => {
      calls.push(req)
      return opts.reply ?? { ok: true, status: 200, json: { ok: true } }
    },
    allowAction: async () => opts.allowAction ?? true,
    audit: async () => {},
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return { client, calls }
}

function errorOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).toBe(true)
  const [first] = result.content as Array<{ text: string }>
  return JSON.parse(first!.text) as { code: string }
}

describe("Ploydok MCP server", () => {
  it("lists read and action tools", async () => {
    const { client } = await connect(mcpUser())
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain("get_runtime_logs")
    expect(names).toContain("deploy_app")
    const deploy = tools.find((t) => t.name === "deploy_app")
    expect(deploy?.annotations?.destructiveHint).toBe(true)
  })

  it("refuses an app outside the token allowlist without calling the API", async () => {
    const { client, calls } = await connect(mcpUser({ token_app_ids: ["a1"] }))
    const result = await client.callTool({
      name: "get_app",
      arguments: { appId: "a2" },
    })
    expect(errorOf(result).code).toBe("TOKEN_RESTRICTED")
    expect(calls).toHaveLength(0)
  })

  it("refuses an app of another organization", async () => {
    const { client, calls } = await connect(mcpUser())
    const result = await client.callTool({
      name: "get_app",
      arguments: { appId: "other_app" },
    })
    expect(errorOf(result).code).toBe("TOKEN_RESTRICTED")
    expect(calls).toHaveLength(0)
  })

  it("refuses deploy_app without the apps:deploy scope", async () => {
    const { client, calls } = await connect(mcpUser())
    const result = await client.callTool({
      name: "deploy_app",
      arguments: { appId: "a1" },
    })
    expect(errorOf(result).code).toBe("FORBIDDEN")
    expect(calls).toHaveLength(0)
  })

  it("posts the deploy through the REST route when allowed", async () => {
    const user = mcpUser({
      token_scopes: ["apps:read", "apps:deploy"],
    })
    const { client, calls } = await connect(user)
    const result = await client.callTool({
      name: "deploy_app",
      arguments: { appId: "a1" },
    })
    expect(result.isError).toBeFalsy()
    expect(calls).toEqual([{ path: "/apps/a1/deploy", method: "POST" }])
  })

  it("stops actions once the token's rate limit is spent", async () => {
    const user = mcpUser({ token_scopes: ["apps:deploy"] })
    const { client, calls } = await connect(user, { allowAction: false })
    const result = await client.callTool({
      name: "restart_app",
      arguments: { appId: "a1" },
    })
    expect(errorOf(result).code).toBe("RATE_LIMITED")
    expect(calls).toHaveLength(0)
  })

  it("keeps services out of reach of an app-limited token", async () => {
    const { client, calls } = await connect(mcpUser({ token_app_ids: ["a1"] }))
    const result = await client.callTool({ name: "list_services" })
    expect(errorOf(result).code).toBe("TOKEN_RESTRICTED")
    expect(calls).toHaveLength(0)
  })

  it("reads build logs from the tail with a byte budget", async () => {
    const { client, calls } = await connect(mcpUser(), {
      reply: { ok: true, status: 200, text: "done", omittedBytes: 10 },
    })
    const result = await client.callTool({
      name: "get_build_logs",
      arguments: { appId: "a1", buildId: "b1" },
    })
    expect(result.isError).toBeFalsy()
    expect(calls[0]).toMatchObject({
      path: "/apps/a1/logs",
      query: { buildId: "b1" },
      tailBytes: 64 * 1024,
    })
  })

  it("surfaces REST errors as tool errors", async () => {
    const { client } = await connect(mcpUser(), {
      reply: {
        ok: false,
        error: { status: 404, code: "NOT_FOUND", message: "App not found" },
      },
    })
    const result = await client.callTool({
      name: "get_app",
      arguments: { appId: "a1" },
    })
    expect(errorOf(result).code).toBe("NOT_FOUND")
  })
})
