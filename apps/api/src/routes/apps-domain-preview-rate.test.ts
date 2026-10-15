// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"

let limiterOptions: {
  windowSec: number
  max: number
  keyPrefix: string
  keyFrom: (context: { get: (key: string) => unknown }) => unknown
} | null = null
let limiterCalls = 0

mock.module("ioredis", () => ({
  default: class FakeRedis {},
}))

mock.module("../webhooks/rate-limit", () => ({
  createRateLimiter: (options: typeof limiterOptions extends infer T ? T : never) => {
    limiterOptions = options as typeof limiterOptions
    return async (_context: unknown, next: () => Promise<Response | void>) => {
      limiterCalls++
      return next()
    }
  },
  checkRateLimit: async () => ({ allowed: true, remaining: 0 }),
  rateLimitKeyFromProviderHeaderOrIp: () => "test",
}))

describe("domain preview rate limit", () => {
  it("mounts a per-user 60 requests/minute limiter before preview validation", async () => {
    const { createAppsRouter } = await import("./apps")
    const app = new Hono()
    app.use("*", async (context, next) => {
      // The standalone Hono test app does not carry the production variable type.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(context as any).set("user", {
        id: "user-1",
        email: "user@example.test",
        display_name: "Test User",
        session_id: "session-1",
      })
      return next()
    })
    app.route("/apps", createAppsRouter({} as never))

    const response = await app.request("/apps/domain-preview")

    expect(response.status).toBe(400)
    expect(limiterCalls).toBe(1)
    expect(limiterOptions).toMatchObject({
      windowSec: 60,
      max: 60,
      keyPrefix: "rl:apps-domain-preview",
    })
    expect(
      limiterOptions?.keyFrom({ get: () => ({ id: "user-1" }) })
    ).toBe("user:user-1")
  })
})
