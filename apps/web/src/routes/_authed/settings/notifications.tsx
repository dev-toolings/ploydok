// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { createPageHead } from "../../../lib/page-metadata"
import { ShellPage } from "../../../components/layout/AppShell"
import { ChannelList } from "../../../components/notifications/ChannelList"

export const Route = createFileRoute("/_authed/settings/notifications")({
  head: createPageHead("notifications"),
  component: NotificationsPage,
})

function NotificationsPage(): React.JSX.Element {
  return (
    <ShellPage
      title="Notifications"
      description="Choose where alerts about your builds and deployments are sent."
    >
      <ChannelList showHeader={false} />
    </ShellPage>
  )
}
