// SPDX-License-Identifier: AGPL-3.0-only
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { createPageHead } from "../../../lib/page-metadata"
import { apiFetch } from "../../../lib/api";
import type { OrganizationSummary } from "@ploydok/shared";

export const Route = createFileRoute("/_authed/orgs/$orgSlug")({
  head: createPageHead("organization"),
  loader: async ({ params }): Promise<{ organization: OrganizationSummary }> => {
    const data = await apiFetch<{ organization: OrganizationSummary }>(
      `/organizations/${params.orgSlug}`,
    );
    return { organization: data.organization };
  },
  component: () => <Outlet />,
});
