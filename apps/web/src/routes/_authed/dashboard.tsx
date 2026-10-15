// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, redirect } from "@tanstack/react-router"
import { createPageHead } from "../../lib/page-metadata"

export const Route = createFileRoute("/_authed/dashboard")({
  head: createPageHead("dashboard"),
  beforeLoad: ({ context }) => {
    const slug = context.me?.default_organization?.slug
    if (!slug) throw redirect({ to: "/login" })
    throw redirect({ href: `/orgs/${slug}/dashboard` })
  },
})
