// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { cn } from "@workspace/ui/lib/utils"
import {
  Outlet,
  createFileRoute,
  redirect,
  useParams,
  useRouterState,
} from "@tanstack/react-router"
import { createPageHead } from "../../../../../lib/page-metadata"
import { AppBar } from "../../../../../components/apps/AppBar"
import { normalizeAppDetail, useApp } from "../../../../../lib/apps"
import { useCurrentOrganizationSlug } from "../../../../../lib/organizations"
import { apiFetch } from "../../../../../lib/api"
import type { RawAppDetail } from "../../../../../lib/apps"
import type { Build, OrganizationSummary } from "@ploydok/shared"

function AppDetailLayout(): React.JSX.Element {
  const { id: routeAppId } = useParams({ strict: false })
  const appId = routeAppId!
  const loaderData = Route.useLoaderData()
  const { data: app } = useApp(appId, { initialData: loaderData.app })
  const currentOrgSlug = useCurrentOrganizationSlug()
  const pathname = useRouterState({
    select: (s) => (s.resolvedLocation ?? s.location).pathname,
  })

  const currentApp = app
  const isLogsRoute =
    pathname === `/apps/${appId}/logs` ||
    pathname === `/orgs/${currentOrgSlug}/apps/${appId}/logs`
  const isShellRoute =
    pathname === `/apps/${appId}/shell` ||
    pathname === `/orgs/${currentOrgSlug}/apps/${appId}/shell`

  return (
    <div
      className={cn(
        "flex w-full flex-1 flex-col bg-background pb-[calc(6rem+env(safe-area-inset-bottom))]",
        !isShellRoute && "mx-auto max-w-[1348px]",
        (isLogsRoute || isShellRoute) && "min-h-0"
      )}
    >
      {currentApp ? <AppBar app={currentApp} /> : null}

      <main
        className={
          isLogsRoute || isShellRoute
            ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            : "min-w-0 flex-1"
        }
      >
        <Outlet />
      </main>
    </div>
  )
}

export const Route = createFileRoute("/_authed/orgs/$orgSlug/apps/$id")({
  head: createPageHead("application"),
  loader: async ({ params }) => {
    const [organizationData, appData] = await Promise.all([
      apiFetch<{ organization: OrganizationSummary }>(
        `/organizations/${params.orgSlug}`
      ),
      apiFetch<{ app: RawAppDetail; builds: Array<Build> }>(
        `/apps/${params.id}`
      ),
    ])
    const app = {
      ...normalizeAppDetail(appData.app),
      builds: appData.builds,
    }
    if (app.status === "deleting") {
      throw redirect({ href: `/orgs/${params.orgSlug}/apps`, replace: true })
    }
    if (
      app.organizationId &&
      app.organizationId !== organizationData.organization.id
    ) {
      throw redirect({ href: `/orgs/${params.orgSlug}/apps`, replace: true })
    }
    return { app }
  },
  component: AppDetailLayout,
})
