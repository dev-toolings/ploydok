// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useParams } from "@tanstack/react-router"
import { createPageHead } from "../../../../../../lib/page-metadata"
import { BuildLogViewer } from "../../../../../../components/apps/BuildLogViewer"
import { useApp } from "../../../../../../lib/apps"

function AppLogsTab(): React.JSX.Element {
  const { id: routeAppId } = useParams({ strict: false })
  const appId = routeAppId!
  const { data: app } = useApp(appId)

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pt-4 md:px-8">
      <BuildLogViewer
        appId={appId}
        appName={app?.name}
        fillHeight
        className="min-h-[min(420px,100%)] flex-1"
      />
    </div>
  )
}

export const Route = createFileRoute("/_authed/orgs/$orgSlug/apps/$id/logs")({
  head: createPageHead("logs"),
  component: AppLogsTab,
})
