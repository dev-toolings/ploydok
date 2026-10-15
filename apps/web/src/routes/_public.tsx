// SPDX-License-Identifier: AGPL-3.0-only
import { Outlet, createFileRoute } from "@tanstack/react-router"
import { createPageHead } from "../lib/page-metadata"
import {
  enforceInstanceState,
  redirectIfAuthenticated,
} from "../lib/auth-guards"

export const Route = createFileRoute("/_public")({
  head: createPageHead("account"),
  beforeLoad: async ({ location }) => {
    await enforceInstanceState(location.pathname)
    if (
      location.pathname !== "/setup" &&
      location.pathname !== "/invitations/accept"
    ) {
      await redirectIfAuthenticated()
    }
  },
  component: () => <Outlet />,
})
