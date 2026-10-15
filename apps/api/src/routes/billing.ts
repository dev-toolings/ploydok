// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import type { Db } from "@ploydok/db"
import { projects, org_subscriptions } from "@ploydok/db"
import { getOrgPlan, hasRole } from "@ploydok/db/queries"
import { CheckoutBodySchema, CurrentPlanResponseSchema } from "@ploydok/shared"
import { env } from "../env"
import { stripeClient } from "../billing/stripe"
import type { AuthUser } from "../auth/middleware"

type AppEnv = { Variables: { user?: AuthUser } }

function getUser(c: { get: (k: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

export function createBillingRouter(db: Db) {
  const router = new Hono<AppEnv>()

  router.post("/checkout", async (c) => {
    const user = getUser(c)

    if (!stripeClient.isConfigured()) {
      return c.json(
        { error: { code: "BILLING_NOT_CONFIGURED" } },
        { status: 501 }
      )
    }

    const body = await c.req.json()
    const parsed = CheckoutBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: "Invalid request body" }, { status: 400 })
    }

    const { planSlug } = parsed.data
    const slug = c.req.param("orgSlug") ?? ""

    if (!slug) {
      return c.json({ error: "Organization not specified" }, { status: 400 })
    }

    const org = await db.query.projects.findFirst({
      where: eq(projects.slug, slug),
    })

    if (!org || !(await hasRole(db, org.id, user.id, ["owner"]))) {
      return c.json({ error: "Organization not found" }, { status: 404 })
    }

    try {
      const url = await stripeClient.createCheckoutSession(
        org.id,
        slug,
        planSlug,
        env.WEB_ORIGIN
      )
      return c.json({ url }, { status: 200 })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Checkout failed" },
        { status: 500 }
      )
    }
  })

  router.post("/portal", async (c) => {
    const user = getUser(c)

    if (!stripeClient.isConfigured()) {
      return c.json(
        { error: { code: "BILLING_NOT_CONFIGURED" } },
        { status: 501 }
      )
    }

    const slug = c.req.param("orgSlug") ?? ""

    if (!slug) {
      return c.json({ error: "Organization not specified" }, { status: 400 })
    }

    const org = await db.query.projects.findFirst({
      where: eq(projects.slug, slug),
    })

    if (!org || !(await hasRole(db, org.id, user.id, ["owner"]))) {
      return c.json({ error: "Organization not found" }, { status: 404 })
    }

    const sub = await db.query.org_subscriptions.findFirst({
      where: eq(org_subscriptions.org_id, org.id),
    })

    if (!sub?.stripe_customer_id) {
      return c.json({ error: "No active subscription found" }, { status: 404 })
    }

    try {
      const url = await stripeClient.createPortalSession(
        sub.stripe_customer_id,
        slug,
        env.WEB_ORIGIN
      )
      return c.json({ url }, { status: 200 })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Portal failed" },
        { status: 500 }
      )
    }
  })

  router.get("/current", async (c) => {
    const user = getUser(c)
    const slug = c.req.param("orgSlug") ?? ""

    if (!slug) {
      return c.json({ error: "Organization not specified" }, { status: 400 })
    }

    const org = await db.query.projects.findFirst({
      where: eq(projects.slug, slug),
    })

    if (!org || !(await hasRole(db, org.id, user.id, ["owner"]))) {
      return c.json({ error: "Organization not found" }, { status: 404 })
    }

    const result = await getOrgPlan(db, org.id)

    if (!result) {
      return c.json(
        { error: "No plan found for organization" },
        { status: 404 }
      )
    }

    const response = {
      plan: {
        slug: result.plan.slug,
        name: result.plan.name,
        price_monthly_cents: result.plan.price_monthly_cents,
        features: result.plan.features,
        quotas: result.plan.quotas,
      },
      subscription: {
        status: result.subscription.status,
        current_period_end: result.subscription.current_period_end,
        cancel_at_period_end: result.subscription.cancel_at_period_end,
      },
    }

    return c.json(CurrentPlanResponseSchema.parse(response), { status: 200 })
  })

  return router
}
