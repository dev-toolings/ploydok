// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createPageHead } from "../../../../lib/page-metadata"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/")({
  head: createPageHead("organization"),
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/orgs/${params.orgSlug}/dashboard`,
      replace: true,
    });
  },
  component: () => null,
});
