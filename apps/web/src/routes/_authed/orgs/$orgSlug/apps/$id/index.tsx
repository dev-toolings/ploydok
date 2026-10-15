// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, redirect } from "@tanstack/react-router"
import { createPageHead } from "../../../../../../lib/page-metadata"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/apps/$id/")({
  head: createPageHead("application"),
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/orgs/${params.orgSlug}/apps/${params.id}/settings`,
      replace: true,
    })
  },
  component: () => null,
})
