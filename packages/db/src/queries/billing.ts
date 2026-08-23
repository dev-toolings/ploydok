// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import type { Db } from "../client"
import { billing_plans, org_subscriptions } from "../schema"
import type { BillingPlanRow, OrgSubscriptionRow } from "../schema"

type SubscriptionDb = Pick<Db, "insert" | "update" | "query">

/**
 * Fetch the billing plan and subscription for an organization.
 * Returns null if no subscription exists for the org.
 */
export async function getOrgPlan(
  db: Db,
  orgId: string
): Promise<{ plan: BillingPlanRow; subscription: OrgSubscriptionRow } | null> {
  const subscription = await db.query.org_subscriptions.findFirst({
    where: eq(org_subscriptions.org_id, orgId),
  })

  if (!subscription) {
    return null
  }

  const plan = await db.query.billing_plans.findFirst({
    where: eq(billing_plans.slug, subscription.plan_slug),
  })

  if (!plan) {
    return null
  }

  return { plan, subscription }
}

/**
 * Check if an organization has a specific feature in its current plan.
 * If no subscription exists, defaults to 'free' plan features.
 */
export async function hasFeature(
  db: Db,
  orgId: string,
  feature: string
): Promise<boolean> {
  const result = await getOrgPlan(db, orgId)

  if (!result) {
    const freePlan = await db.query.billing_plans.findFirst({
      where: eq(billing_plans.slug, "free"),
    })
    if (!freePlan) {
      return false
    }
    const features = freePlan.features as Record<string, boolean>
    return features[feature] ?? false
  }

  const features = result.plan.features as Record<string, boolean>
  return features[feature] ?? false
}

/**
 * Check if an organization is within quota for a specific limit.
 * If no subscription exists, defaults to 'free' plan quotas.
 *
 * @param currentUsage Current usage count (provided by caller)
 * @returns true if within quota, false if at or over limit
 *
 * Note: 0 in quotas means unlimited.
 */
export async function hasQuota(
  db: Db,
  orgId: string,
  quota: string,
  currentUsage: number
): Promise<boolean> {
  const result = await getOrgPlan(db, orgId)

  let quotas: Record<string, number>

  if (!result) {
    const freePlan = await db.query.billing_plans.findFirst({
      where: eq(billing_plans.slug, "free"),
    })
    if (!freePlan) {
      return false
    }
    quotas = freePlan.quotas as Record<string, number>
  } else {
    quotas = result.plan.quotas as Record<string, number>
  }

  const limit = quotas[quota]

  if (limit === undefined) {
    return false
  }

  if (limit === 0) {
    return true
  }

  return currentUsage < limit
}

/**
 * Create or update an organization subscription to a plan.
 */
export async function setOrgSubscription(
  db: SubscriptionDb,
  orgId: string,
  planSlug: string,
  status: "active" | "trialing" | "past_due" | "canceled" = "active"
): Promise<OrgSubscriptionRow> {
  const existing = await db.query.org_subscriptions.findFirst({
    where: eq(org_subscriptions.org_id, orgId),
  })

  if (existing) {
    const updated = await db
      .update(org_subscriptions)
      .set({
        plan_slug: planSlug,
        status,
        updated_at: new Date(),
      })
      .where(eq(org_subscriptions.org_id, orgId))
      .returning()

    return updated[0]!
  }

  const inserted = await db
    .insert(org_subscriptions)
    .values({
      id: nanoid(),
      org_id: orgId,
      plan_slug: planSlug,
      status,
    })
    .returning()

  return inserted[0]!
}
