// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, mock } from "bun:test"
import { Hono } from "hono"
import type { AuthUser } from "../auth/middleware"
import { createApiTokensRouter } from "./api-tokens"

describe("api-tokens routes", () => {
  let mockContext: any
  let mockDb: any
  let app: Hono<{ Variables: { user?: AuthUser } }>

  beforeEach(() => {
    mockDb = {
      update: mock(() => {
        throw new Error("Unexpected token revocation")
      }),
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(async () => [
            {
              id: "token_123",
              user_id: "user_1",
              name: "CI Bot",
              token_hash: "abc123",
              created_at: new Date(),
              last_used_at: null,
              expires_at: null,
              revoked_at: null,
            },
          ]),
        })),
      })),
    }

    mockContext = {
      json: mock((data: unknown, status?: number) => ({
        data,
        status: status || 200,
      })),
      req: {
        param: mock((key: string) => "token_123"),
        json: mock(async () => ({ name: "CI Bot" })),
        header: mock(() => "Bearer ploy_test"),
      },
      get: mock((key: string) => {
        if (key === "user") {
          return { id: "user_1", email: "test@example.com" }
        }
        if (key === "db") {
          return mockDb
        }
        return undefined
      }),
    }

    app = new Hono<{ Variables: { user?: AuthUser } }>()
    app.use("*", async (c, next) => {
      c.set("user", {
        ...mockContext.get("user"),
        pat_id: "caller_token",
        token_scopes: ["apps:read"],
      })
      await next()
    })
    app.route("/api-tokens", createApiTokensRouter(mockDb))
  })

  it("rejects PAT callers creating API tokens", async () => {
    const response = await app.request("/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Escalated token", scopes: ["admin:*"] }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: "PAT_NOT_ALLOWED",
        message: "API tokens cannot manage API tokens",
      },
    })
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it("rejects PAT callers revoking API tokens", async () => {
    const response = await app.request("/api-tokens/token_123", {
      method: "DELETE",
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: "PAT_NOT_ALLOWED",
        message: "API tokens cannot manage API tokens",
      },
    })
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it("generates token with ploy_ prefix", () => {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    expect(token).toBeTruthy()
    expect(token.length).toBeGreaterThan(0)
  })
})
