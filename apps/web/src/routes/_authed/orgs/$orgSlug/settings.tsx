// SPDX-License-Identifier: AGPL-3.0-only
import { Link, Outlet, createFileRoute } from "@tanstack/react-router"
import { createPageHead } from "../../../../lib/page-metadata"
import { useCurrentPlanQuery } from "../../../../lib/billing"
import { useTranslation } from "react-i18next"
import type * as React from "react"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/settings")({
  head: createPageHead("organizationSettings"),
  component: SettingsLayout,
})

function SettingsLayout(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const { orgSlug } = Route.useParams()
  const planQuery = useCurrentPlanQuery(orgSlug)
  const showSso = planQuery.data?.plan.features.sso === true

  const tabClass =
    "rounded-[10px] px-3 py-1.5 text-sm font-medium text-neutral-500 transition-colors hover:text-neutral-800 data-[status=active]:bg-white data-[status=active]:text-neutral-950 data-[status=active]:shadow-[var(--shadow-xs)] dark:data-[status=active]:bg-neutral-950 dark:data-[status=active]:text-neutral-50"

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      <nav
        className="flex flex-wrap gap-1 rounded-2xl bg-panel p-1"
        aria-label="Workspace settings"
      >
        <Link
          to="/orgs/$orgSlug/settings/general"
          params={{ orgSlug }}
          className={tabClass}
          activeProps={{ "data-status": "active" }}
        >
          General
        </Link>
        <Link
          to="/orgs/$orgSlug/settings/billing"
          params={{ orgSlug }}
          search={{ success: false, canceled: false }}
          className={tabClass}
          activeProps={{ "data-status": "active" }}
        >
          Billing
        </Link>
        {showSso ? (
          <Link
            to="/orgs/$orgSlug/settings/sso"
            params={{ orgSlug }}
            className={tabClass}
            activeProps={{ "data-status": "active" }}
          >
            SSO
          </Link>
        ) : null}
        <Link
          to="/orgs/$orgSlug/branding"
          params={{ orgSlug }}
          className={tabClass}
          activeProps={{ "data-status": "active" }}
        >
          Branding
        </Link>
        <Link
          to="/orgs/$orgSlug/settings/github"
          params={{ orgSlug }}
          className={tabClass}
          activeProps={{ "data-status": "active" }}
        >
          {t("settings.github")}
        </Link>
      </nav>
      <Outlet />
    </div>
  )
}
