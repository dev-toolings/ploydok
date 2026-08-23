// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import type { Db } from "@ploydok/db"

const createCheckoutSession = mock(async () => "https://checkout.test/session")
const createPortalSession = mock(async () => "https://portal.test/session")
let stripeConfigured = true

mock.module("../billing/stripe", () => ({
  stripeClient: {
    isConfigured: () => stripeConfigured,
    createCheckoutSession,
    createPortalSession,
  },
}))

const { createBillingRouter } = await import("./billing")

const fakeUser = {
  id: "user-1",
  email: "test@example.com",
  display_name: "Test User",
  session_id: "session-1",
}

function fakeBillingDb(opts?: {
  org?: { id: string; slug: string } | null
  subscription?: { stripe_customer_id: string | null } | null
}): Db {
  return {
    query: {
      projects: {
        findFirst: async () =>
          opts && "org" in opts ? opts.org : { id: "org-1", slug: "acme" },
      },
      org_subscriptions: {
        findFirst: async () =>
          opts && "subscription" in opts
            ? opts.subscription
            : { stripe_customer_id: "cus_1" },
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: "mem-1" }],
        }),
      }),
    }),
  } as unknown as Db
}

function buildApp(db: Db) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("user", fakeUser)
    await next()
  })
  app.route("/:orgSlug/billing", createBillingRouter(db))
  return app
}

describe("billing routes", () => {
  beforeEach(() => {
    stripeConfigured = true
    createCheckoutSession.mockClear()
    createPortalSession.mockClear()
    createCheckoutSession.mockResolvedValue("https://checkout.test/session")
    createPortalSession.mockResolvedValue("https://portal.test/session")
  })

  it("POST /checkout returns 501 when Stripe is not configured", async () => {
    stripeConfigured = false
    const app = buildApp(fakeBillingDb())

    const res = await app.request("/acme/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planSlug: "pro" }),
    })

    expect(res.status).toBe(501)
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })

  it("POST /checkout passes the real org slug to Stripe", async () => {
    const app = buildApp(fakeBillingDb())

    const res = await app.request("/acme/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planSlug: "pro" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: "https://checkout.test/session" })
    expect(createCheckoutSession).toHaveBeenCalledTimes(1)
    const args = createCheckoutSession.mock.calls[0] as unknown[]
    expect(args[0]).toBe("org-1")
    expect(args[1]).toBe("acme")
    expect(args[1]).not.toBe("~")
    expect(args[2]).toBe("pro")
  })

  it("POST /portal passes the real org slug to Stripe", async () => {
    const app = buildApp(fakeBillingDb())

    const res = await app.request("/acme/billing/portal", {
      method: "POST",
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: "https://portal.test/session" })
    expect(createPortalSession).toHaveBeenCalledTimes(1)
    const args = createPortalSession.mock.calls[0] as unknown[]
    expect(args[0]).toBe("cus_1")
    expect(args[1]).toBe("acme")
    expect(args[1]).not.toBe("~")
  })
})
