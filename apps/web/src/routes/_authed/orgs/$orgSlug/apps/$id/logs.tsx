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
    <BuildLogViewer
      appId={appId}
      appName={app?.name}
      className="flex-1 min-h-0 rounded-none border-0"
    />
  )
}

export const Route = createFileRoute("/_authed/orgs/$orgSlug/apps/$id/logs")({
  head: createPageHead("logs"),
  component: AppLogsTab,
})
