// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { createFileRoute, useSearch } from "@tanstack/react-router"
import { Suspense } from "react"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../../lib/page-metadata"
import { ShellPage } from "../../../../../components/layout/AppShell"
import {
  useBillingPortal,
  useCheckoutSession,
  useCurrentPlan,
} from "../../../../../lib/billing"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/settings/billing")(
  {
  head: createPageHead("billing"),
    component: BillingPage,
    validateSearch: (search: Record<string, unknown>) => ({
      success: search.success === "1" || search.success === 1,
      canceled: search.canceled === "1" || search.canceled === 1,
    }),
  }
)

function BillingPage(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const { orgSlug } = Route.useParams()
  const { success, canceled } = useSearch({ from: Route.id })

  return (
    <ShellPage
      title={t("billing.title")}
      description={t("billing.description")}
    >
      <Suspense fallback={<Skeleton className="h-48 w-full rounded-2xl" />}>
        <BillingContent
          orgSlug={orgSlug}
          showSuccess={success}
          showCanceled={canceled}
        />
      </Suspense>
    </ShellPage>
  )
}

interface BillingContentProps {
  orgSlug: string
  showSuccess: boolean
  showCanceled: boolean
}

function BillingContent({
  orgSlug,
  showSuccess,
  showCanceled,
}: BillingContentProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const { data } = useCurrentPlan(orgSlug)
  const checkoutMutation = useCheckoutSession()
  const portalMutation = useBillingPortal()

  const handleUpgrade = (planSlug: "pro" | "enterprise") => {
    checkoutMutation.mutate(
      { planSlug, orgSlug },
      {
        onSuccess: (result) => {
          window.location.href = result.url
        },
      }
    )
  }

  const handleManageSubscription = () => {
    portalMutation.mutate(
      { orgSlug },
      {
        onSuccess: (result) => {
          window.location.href = result.url
        },
      }
    )
  }

  return (
    <div className="space-y-6">
      {showSuccess && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-green-800">
          {t("billing.activated")}
        </div>
      )}

      {showCanceled && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-yellow-800">
          {t("billing.canceled")}
        </div>
      )}

      <div className="space-y-4">
        <h3 className="text-base font-medium">{t("billing.currentPlan")}</h3>
        <div className="rounded-lg border p-6">
          <div className="space-y-2">
            <div className="text-2xl font-bold">{data.plan.name}</div>
            <div className="text-sm text-gray-600">
              ${(data.plan.price_monthly_cents / 100).toFixed(2)}/month
            </div>
            {data.plan.price_monthly_cents === 0 && (
              <div className="text-xs text-gray-500">{t("billing.alwaysFree")}</div>
            )}
          </div>
        </div>
      </div>

      {data.subscription.status === "active" && (
        <div className="space-y-4">
          <h3 className="text-base font-medium">{t("billing.subscription")}</h3>
          <div className="rounded-lg border p-6">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span>{t("billing.status")}</span>
                <span className="font-semibold">
                  {data.subscription.status}
                </span>
              </div>
              {data.subscription.current_period_end && (
                <div className="flex justify-between text-sm">
                  <span>{t("billing.renewsOn")}</span>
                  <span>
                    {new Date(
                      data.subscription.current_period_end
                    ).toLocaleDateString()}
                  </span>
                </div>
              )}
              {data.subscription.cancel_at_period_end && (
                <div className="rounded bg-yellow-50 p-2 text-yellow-800">
                  {t("billing.willCancel")}
                </div>
              )}
            </div>
          </div>
          {data.plan.slug !== "enterprise" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleManageSubscription}
              loading={portalMutation.isPending}
            >
              {portalMutation.isPending
                ? t("billing.openingStripe")
                : t("billing.manage")}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-4">
        <h3 className="text-base font-medium">{t("billing.availablePlans")}</h3>
        <div className="space-y-3">
          {["pro", "enterprise"].map((planSlug) => (
            <div key={planSlug} className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold capitalize">{planSlug}</div>
                  <div className="text-sm text-gray-600">
                    ${planSlug === "pro" ? 29 : 99}/month
                  </div>
                </div>
                {data.plan.slug !== planSlug && (
                  <Button
                    size="sm"
                    onClick={() =>
                      handleUpgrade(planSlug as "pro" | "enterprise")
                    }
                    loading={checkoutMutation.isPending}
                  >
                    {checkoutMutation.isPending
                      ? t("billing.openingStripe")
                      : t("billing.upgrade")}
                  </Button>
                )}
                {data.plan.slug === planSlug && (
                  <div className="text-sm text-gray-500">{t("billing.current")}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
