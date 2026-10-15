// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, notFound } from "@tanstack/react-router"
import { createPageHead } from "../../../../lib/page-metadata"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/shared-env")({
  head: createPageHead("sharedEnv"),
  beforeLoad: () => {
    throw notFound()
  },
})
