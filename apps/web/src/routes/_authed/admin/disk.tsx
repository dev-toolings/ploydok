// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_authed/admin/disk")({
  beforeLoad: ({ context }) => {
    const slug = context.me.default_organization?.slug
    if (!slug) throw redirect({ to: "/onboarding" })
    throw redirect({ href: `/orgs/${slug}/disk` })
  },
})
