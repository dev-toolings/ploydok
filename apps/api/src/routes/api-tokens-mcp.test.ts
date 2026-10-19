// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import type { AuthUser } from "../auth/middleware"

let ownerOrgs: string[] = []
let memberOrgs: string[] = []
const created: Array<Record<string, unknown>> = []

mock.module("@ploydok/db/queries", () => ({
  hasRole: async (
    _db: unknown,
    orgId: string,
    _userId: string,
    roles: string[]
  ) =>
    ownerOrgs.includes(orgId) ||
    (roles.includes("member") && memberOrgs.includes(orgId)),
  createToken: async (_db: unknown, params: Record<string, unknown>) => {
    created.push(params)
    return {
      id: "tok_new",
      name: params.name,
      scopes: params.scopes,
      created_at: new Date(),
      last_used_at: null,
      expires_at: params.expiresAt,
      revoked_at: null,
      kind: params.kind,
      org_id: params.orgId,
      app_ids: params.appIds ?? null,
    }
  },
  listTokensForUser: async () => [],
  revokeToken: async () => {},
}))

const { createApiTokensRouter } = await import("./api-tokens")

// Apps a1 and a2 belong to org_1.
const db = {
  select: () => ({
    from: () => ({
      where: async () => [{ id: "a1" }, { id: "a2" }].slice(0, appsFound),
    }),
  }),
}
let appsFound = 2

function request(user: Partial<AuthUser>, body: unknown) {
  const app = new Hono<{ Variables: { user: AuthUser } }>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1", ...user } as AuthUser)
    await next()
  })
  app.route("/api-tokens", createApiTokensRouter(db as never))
  return app.request("/api-tokens/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api-tokens/mcp", () => {
  beforeEach(() => {
    ownerOrgs = []
    memberOrgs = []
    created.length = 0
    appsFound = 2
  })

  it("refuses a caller authenticated with an API token", async () => {
    ownerOrgs = ["org_1"]
    const res = await request(
      { pat_id: "tok_1" },
      { name: "agent", orgId: "org_1" }
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { code: "PAT_NOT_ALLOWED" },
    })
  })

  it("refuses a user outside the organization", async () => {
    const res = await request({}, { name: "agent", orgId: "org_1" })
    expect(res.status).toBe(403)
  })

  it("refuses deployments to a plain member", async () => {
    memberOrgs = ["org_1"]
    const res = await request(
      {},
      { name: "agent", orgId: "org_1", allowDeploy: true }
    )
    expect(res.status).toBe(403)
    expect(created).toHaveLength(0)
  })

  it("refuses an app from another organization", async () => {
    memberOrgs = ["org_1"]
    appsFound = 1
    const res = await request(
      {},
      { name: "agent", orgId: "org_1", appIds: ["a1", "x9"] }
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: "APP_NOT_IN_ORG" },
    })
  })

  it("issues an org-bound mcp token with derived scopes", async () => {
    ownerOrgs = ["org_1"]
    const res = await request(
      {},
      { name: "agent", orgId: "org_1", appIds: ["a1", "a2"], allowDeploy: true }
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string }
    expect(body.token.startsWith("plk_live_")).toBe(true)
    expect(created[0]).toMatchObject({
      kind: "mcp",
      orgId: "org_1",
      appIds: ["a1", "a2"],
      scopes: ["apps:read", "services:read", "databases:read", "apps:deploy"],
    })
  })
})
