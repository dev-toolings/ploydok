// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AuthUser } from "../auth/middleware"
import { createMcpHandler } from "./route"

function mount(user: Partial<AuthUser>) {
  const app = new Hono<{ Variables: { user: AuthUser } }>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1", ...user } as AuthUser)
    await next()
  })
  app.all(
    "/mcp",
    createMcpHandler({} as never, app, {
      store: {
        resourceOrgId: async () => "org_1",
        orgSlug: async () => "acme",
      },
      allowAction: async () => true,
      audit: async () => {},
    })
  )
  return app
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
}

function post(app: Hono<never>, body: unknown) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  })
}

describe("/mcp handler", () => {
  it("refuses a browser session", async () => {
    const res = await post(mount({}) as never, initialize)
    expect(res.status).toBe(401)
  })

  it("answers initialize for an MCP token", async () => {
    const app = mount({
      pat_id: "tok_1",
      token_kind: "mcp",
      token_org_id: "org_1",
      token_scopes: ["apps:read"],
    })
    const res = await post(app as never, initialize)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      result: { serverInfo: { name: "ploydok" } },
    })
  })

  it("rejects GET: the endpoint is stateless", async () => {
    const res = await mount({ token_kind: "mcp" }).request("/mcp")
    expect(res.status).toBe(405)
  })
})
