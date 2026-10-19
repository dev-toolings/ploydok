// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AuthUser } from "../auth/middleware"
import { getMcpPrincipal } from "../auth/mcp-principal"
import { createApiCaller } from "./call"

const user = { id: "user_1", token_kind: "mcp" } as AuthUser

function fakeApp() {
  const app = new Hono()
  app.get("/log", (c) => c.text("x".repeat(10_000) + "END"))
  app.get("/whoami", (c) => c.json({ id: getMcpPrincipal(c)?.id ?? null }))
  app.get("/fail", (c) =>
    c.json({ error: { code: "NOT_FOUND", message: "App not found" } }, 404)
  )
  return app
}

describe("createApiCaller", () => {
  it("keeps only the tail of a text body within the byte budget", async () => {
    const call = createApiCaller(fakeApp(), {}, user)
    const res = await call({ path: "/log", tailBytes: 100 })
    if (!res.ok || !("text" in res)) throw new Error("expected text")
    expect(res.text.length).toBe(100)
    expect(res.text.endsWith("END")).toBe(true)
    expect(res.omittedBytes).toBe(9_903)
  })

  it("runs the route as the MCP principal", async () => {
    const call = createApiCaller(fakeApp(), {}, user)
    const res = await call({ path: "/whoami" })
    expect(res).toMatchObject({ ok: true, json: { id: "user_1" } })
  })

  it("normalizes nested API errors", async () => {
    const call = createApiCaller(fakeApp(), {}, user)
    const res = await call({ path: "/fail" })
    expect(res).toEqual({
      ok: false,
      error: { status: 404, code: "NOT_FOUND", message: "App not found" },
    })
  })
})
