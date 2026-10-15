// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, redirect } from "@tanstack/react-router"
import { createPageHead } from "../../lib/page-metadata"

export const Route = createFileRoute("/_public/")({
  head: createPageHead("login"),
  beforeLoad: () => {
    throw redirect({ to: "/login" })
  },
  component: () => null,
})
