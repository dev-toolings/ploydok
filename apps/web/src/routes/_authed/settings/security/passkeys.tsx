// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, redirect } from "@tanstack/react-router"
import { createPageHead } from "../../../../lib/page-metadata"

export const Route = createFileRoute("/_authed/settings/security/passkeys")({
  head: createPageHead("passkey"),
  beforeLoad: () => {
    throw redirect({ to: "/settings/security/passkey" })
  },
  component: () => null,
})
