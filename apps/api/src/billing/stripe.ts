// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm"
import Stripe from "stripe"
import type { Db } from "@ploydok/db"
import { org_subscriptions } from "@ploydok/db"
import { setOrgSubscription } from "@ploydok/db/queries"
import { env } from "../env"
import { childLogger } from "../logger"

const log = childLogger("billing.stripe")

export function billingSettingsUrl(
  webOrigin: string,
  orgSlug: string,
  query?: Record<string, string>
): string {
  const url = new URL(
    `/orgs/${encodeURIComponent(orgSlug)}/settings/billing`,
    webOrigin
  )
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

export class StripeClient {
  private client: Stripe | null = null

  constructor() {
    if (env.STRIPE_SECRET_KEY) {
      this.client = new Stripe(env.STRIPE_SECRET_KEY)
    }
  }

  isConfigured(): boolean {
    return this.client !== null
  }

  async createCheckoutSession(
    orgId: string,
    orgSlug: string,
    planSlug: string,
    webOrigin: string
  ): Promise<string> {
    if (!this.client) {
      throw new Error("Stripe not configured")
    }

    const priceId =
      planSlug === "enterprise"
        ? env.STRIPE_ENTERPRISE_PRICE_ID
        : env.STRIPE_PRO_PRICE_ID

    if (!priceId) {
      throw new Error(`Missing Stripe price ID for plan ${planSlug}`)
    }

    const session = await this.client.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: billingSettingsUrl(webOrigin, orgSlug, { success: "1" }),
      cancel_url: billingSettingsUrl(webOrigin, orgSlug, { canceled: "1" }),
      metadata: {
        org_id: orgId,
        plan_slug: planSlug,
      },
    })

    if (!session.url) {
      throw new Error("Failed to create Stripe checkout session")
    }

    return session.url
  }

  async createPortalSession(
    stripeCustomerId: string,
    orgSlug: string,
    webOrigin: string
  ): Promise<string> {
    if (!this.client) {
      throw new Error("Stripe not configured")
    }

    const session = await this.client.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: billingSettingsUrl(webOrigin, orgSlug),
    })

    return session.url
  }

  async syncSubscriptionFromWebhook(
    db: Db,
    event: Stripe.Event
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Stripe not configured")
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const orgId = session.metadata?.org_id
        const planSlug = session.metadata?.plan_slug
        const customerId = session.customer as string

        if (!orgId || !planSlug) {
          log.warn("Missing metadata in checkout.session.completed event")
          return
        }

        const subscription = await this.client.subscriptions.retrieve(
          session.subscription as string
        )

        await setOrgSubscription(db, orgId, planSlug, "active")

        await db
          .update(org_subscriptions)
          .set({
            stripe_customer_id: customerId,
            stripe_subscription_id: subscription.id,
            current_period_end: new Date(
              ((subscription as any).current_period_end as number) * 1000
            ),
            updated_at: new Date(),
          })
          .where(eq(org_subscriptions.org_id, orgId))

        log.info(
          { orgId, planSlug, subscriptionId: subscription.id },
          "Subscription synced from checkout"
        )
        break
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        const result = await db.query.org_subscriptions.findFirst({
          where: eq(org_subscriptions.stripe_customer_id, customerId),
        })

        if (!result) {
          log.warn({ customerId }, "Subscription update for unknown customer")
          return
        }

        const status =
          subscription.status === "active" || subscription.status === "trialing"
            ? (subscription.status as "active" | "trialing")
            : subscription.status === "past_due"
              ? ("past_due" as const)
              : ("canceled" as const)

        await db
          .update(org_subscriptions)
          .set({
            status,
            current_period_end: new Date(
              ((subscription as any).current_period_end as number) * 1000
            ),
            cancel_at_period_end: subscription.cancel_at_period_end ?? false,
            updated_at: new Date(),
          })
          .where(eq(org_subscriptions.org_id, result.org_id))

        log.info({ customerId, status }, "Subscription updated")
        break
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        const result = await db.query.org_subscriptions.findFirst({
          where: eq(org_subscriptions.stripe_customer_id, customerId),
        })

        if (!result) {
          log.warn({ customerId }, "Subscription deletion for unknown customer")
          return
        }

        await setOrgSubscription(db, result.org_id, "free", "canceled")

        log.info(
          { customerId, orgId: result.org_id },
          "Subscription deleted, downgraded to free"
        )
        break
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string

        const result = await db.query.org_subscriptions.findFirst({
          where: eq(org_subscriptions.stripe_customer_id, customerId),
        })

        if (!result) {
          log.warn({ customerId }, "Payment failure for unknown customer")
          return
        }

        await db
          .update(org_subscriptions)
          .set({
            status: "past_due",
            updated_at: new Date(),
          })
          .where(eq(org_subscriptions.org_id, result.org_id))

        log.info(
          { customerId, orgId: result.org_id },
          "Subscription marked as past_due"
        )
        break
      }

      default:
        log.debug({ eventType: event.type }, "Unhandled webhook event")
    }
  }

  async verifyWebhookSignature(
    body: string,
    signature: string
  ): Promise<Stripe.Event> {
    if (!this.client) {
      throw new Error("Stripe not configured")
    }

    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new Error("Stripe webhook secret not configured")
    }

    return this.client.webhooks.constructEvent(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    )
  }
}

export const stripeClient = new StripeClient()
