// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"

mock.module("@ploydok/db/queries", () => ({
  getActiveToken: async () => ({
    id: "tok_1",
    user_id: "user_1",
    bcrypt_hash: null,
    scopes: ["apps:read"],
    kind: "mcp",
    org_id: "org_1",
    app_ids: ["a1"],
  }),
  getUser: async () => ({
    id: "user_1",
    email: "dev@example.com",
    display_name: "Dev",
  }),
  updateTokenLastUsed: async () => {},
}))

const { authenticatePat } = await import("./pat")

function ctx(path: string) {
  return {
    req: {
      header: () => "Bearer plk_live_mcp",
      path,
      method: "POST",
      url: `http://api${path}`,
    },
  } as never
}

const db = { insert: () => ({ values: async () => {} }) } as never

describe("authenticatePat with an MCP token", () => {
  it("is rejected outside /mcp", async () => {
    expect(await authenticatePat(ctx("/apps/a1/deploy"), db)).toEqual({
      kind: "invalid",
    })
  })

  it("carries its org and app allowlist on /mcp", async () => {
    const result = await authenticatePat(ctx("/mcp"), db)
    expect(result).toMatchObject({
      kind: "ok",
      user: { token_kind: "mcp", token_org_id: "org_1", token_app_ids: ["a1"] },
    })
  })
})
