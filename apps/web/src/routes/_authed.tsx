// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Outlet, createFileRoute } from "@tanstack/react-router"
import { createPageHead } from "../lib/page-metadata"
import { AppShell } from "../components/layout/AppShell"
import { EventsProvider } from "../lib/events-provider"
import { useDeploymentToasts } from "../lib/deployment-toasts"
import { requireOnboardedSession } from "../lib/auth-guards"
import type { Me } from "@ploydok/shared"

function AuthedLayout(): React.JSX.Element {
  useDeploymentToasts()
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

// Legacy path redirects (/dashboard, /apps/**, /databases/**) are handled by
// dedicated splat/stub routes — see _authed/dashboard.tsx, _authed/apps.$.tsx
// and _authed/databases.$.tsx. This layout just runs the shared auth guard.
export const Route = createFileRoute("/_authed")({
  head: createPageHead("dashboard"),
  beforeLoad: async (): Promise<{ me: Me }> => {
    return { me: await requireOnboardedSession() }
  },
  component: () => (
    <EventsProvider>
      <AuthedLayout />
    </EventsProvider>
  ),
})
