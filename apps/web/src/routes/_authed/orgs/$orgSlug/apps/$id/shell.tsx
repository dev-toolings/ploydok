// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useParams } from "@tanstack/react-router"
import { createPageHead } from "../../../../../../lib/page-metadata"
import { Shell } from "../../../../../../components/apps/Shell"

function ShellPage(): React.JSX.Element {
  const { id: routeAppId } = useParams({ strict: false })
  const appId = routeAppId!

  return <Shell appId={appId} />
}

export const Route = createFileRoute("/_authed/orgs/$orgSlug/apps/$id/shell")({
  head: createPageHead("shell"),
  component: ShellPage,
})
