// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { billingSettingsUrl, StripeClient } from "./stripe"

describe("billingSettingsUrl", () => {
  it("points at the real org billing settings path", () => {
    const url = billingSettingsUrl("https://app.example", "acme")

    expect(url).toContain("/orgs/acme/settings/billing")
    expect(url).not.toContain("/orgs~/")
    expect(url).not.toContain("/orgs/~")
    expect(url).toBe("https://app.example/orgs/acme/settings/billing")
  })

  it("attaches checkout query flags used by Stripe redirects", () => {
    expect(
      billingSettingsUrl("https://app.example", "acme", { success: "1" })
    ).toBe("https://app.example/orgs/acme/settings/billing?success=1")
    expect(
      billingSettingsUrl("https://app.example", "acme", { canceled: "1" })
    ).toBe("https://app.example/orgs/acme/settings/billing?canceled=1")
  })

  it("encodes the org slug so it cannot become a path segment", () => {
    const url = billingSettingsUrl("https://app.example", "acme/co")

    expect(url).toBe("https://app.example/orgs/acme%2Fco/settings/billing")
    expect(url).not.toContain("/orgs/acme/co/")
  })
})

describe("StripeClient", () => {
  it("isConfigured returns false when STRIPE_SECRET_KEY is not set", () => {
    const client = new StripeClient()
    expect(client.isConfigured()).toBe(false)
  })

  it("createCheckoutSession throws when not configured", async () => {
    const client = new StripeClient()
    try {
      await client.createCheckoutSession(
        "org-123",
        "acme",
        "pro",
        "http://localhost"
      )
      expect.unreachable()
    } catch (e) {
      expect(e instanceof Error).toBe(true)
      expect((e as Error).message).toContain("not configured")
    }
  })

  it("verifyWebhookSignature throws when not configured", async () => {
    const client = new StripeClient()
    try {
      await client.verifyWebhookSignature("body", "signature")
      expect.unreachable()
    } catch (e) {
      expect(e instanceof Error).toBe(true)
      expect((e as Error).message).toContain("not configured")
    }
  })
})
