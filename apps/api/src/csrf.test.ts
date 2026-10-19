// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { app } from "./app"

describe("CSRF", () => {
  it("POST without csrf header/cookie returns 403", async () => {
    const res = await app.request("/auth/logout", {
      method: "POST",
    })
    expect(res.status).toBe(403)
  })

  it("keeps public invitation registration behind CSRF", async () => {
    const res = await app.request("/invitations/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "invalid",
        display_name: "Test",
        password: "long-enough-password",
      }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: "CSRF_MISMATCH" } })
  })

  it("GET /auth/csrf sets csrf cookie and returns token", async () => {
    const res = await app.request("/auth/csrf")
    expect(res.status).toBe(200)

    const body = (await res.json()) as { token: string }
    expect(typeof body.token).toBe("string")
    expect(body.token.length).toBeGreaterThan(0)

    const setCookie = res.headers.get("set-cookie")
    expect(setCookie).not.toBeNull()
    expect(setCookie).toContain("csrf=")
  })

  it("POST with matching csrf cookie + header passes CSRF check (returns 401 auth required, not 403)", async () => {
    // First get a token
    const csrfRes = await app.request("/auth/csrf")
    const { token } = (await csrfRes.json()) as { token: string }

    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `csrf=${token}`,
        "x-csrf-token": token,
      },
    })

    // CSRF check passed — route now requires auth so returns 401 (not 403 CSRF error)
    expect(res.status).toBe(401)
  })

  it("POST with mismatched csrf cookie and header returns 403", async () => {
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: {
        Cookie: "csrf=aaaa-bbbb",
        "x-csrf-token": "xxxx-yyyy",
      },
    })
    expect(res.status).toBe(403)
  })

  // Les autres routes /auth/setup/* sont exemptées de CSRF parce que le token
  // du wizard voyage dans le corps. /auth/setup/session ÉMET le cookie qui
  // porte ce token : sans double-submit, une page tierce pourrait le faire
  // émettre puis s'en servir. L'exemption ne doit jamais l'inclure.
  it("keeps POST /auth/setup/session behind CSRF", async () => {
    const res = await app.request("/auth/setup/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { code: "CSRF_MISMATCH" },
    })
  })

  describe("POST /mcp", () => {
    it("passes CSRF for a Bearer client without session cookie", async () => {
      // A non-token Bearer reaches the auth stage without a DB lookup.
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { authorization: "Bearer test" },
      })
      expect(res.status).toBe(401)
    })

    it("keeps CSRF when a session cookie rides along", async () => {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          cookie: "ploydok_access=session",
        },
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        error: { code: "CSRF_MISMATCH" },
      })
    })

    it("does not exempt Bearer mutations on other paths", async () => {
      const res = await app.request("/apps/a1/deploy", {
        method: "POST",
        headers: { authorization: "Bearer test" },
      })
      expect(res.status).toBe(403)
    })
  })
})
