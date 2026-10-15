// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, redirect } from "@tanstack/react-router"
import { createPageHead } from "../../../../../lib/page-metadata"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/settings/")({
  head: createPageHead("organizationSettings"),
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/orgs/$orgSlug/settings/general",
      params: { orgSlug: params.orgSlug },
    })
  },
})
