// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router"
import { createPageHead } from "../../../../lib/page-metadata"
import { SecurityPasskeysPanel } from "../../../../components/settings/SecurityPasskeysPanel"

export const Route = createFileRoute("/_authed/settings/security/passkey")({
  head: createPageHead("passkey"),
  component: SecurityPasskeysPanel,
})
