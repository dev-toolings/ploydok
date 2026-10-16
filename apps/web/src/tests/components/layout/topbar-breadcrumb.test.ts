// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {

  extractAppId,
  extractAppName,
  resolveTopbarBreadcrumb
} from "../../../components/layout/topbar-breadcrumb"
import type {MatchWithLoader} from "../../../components/layout/topbar-breadcrumb";

describe("extractAppId", () => {
  it("reads the app id from the app layout loader data", () => {
    const matches: Array<MatchWithLoader> = [
      {
        routeId: "/_authed/orgs/$orgSlug/databases/$id",
        params: { id: "db-1" },
      },
      {
        routeId: "/_authed/orgs/$orgSlug/apps/$id",
        params: { id: "route-app-id" },
        loaderData: { app: { id: "app-123" } },
      },
    ]

    expect(extractAppId(matches)).toBe("app-123")
  })

  it("falls back to the app route id param", () => {
    const matches: Array<MatchWithLoader> = [
      {
        routeId: "/_authed/orgs/$orgSlug/apps/$id",
        params: { id: "app-from-route" },
      },
    ]

    expect(extractAppId(matches)).toBe("app-from-route")
  })

  it("ignores non-app id params", () => {
    const matches: Array<MatchWithLoader> = [
      {
        routeId: "/_authed/orgs/$orgSlug/databases/$id",
        params: { id: "db-1" },
      },
    ]

    expect(extractAppId(matches)).toBeNull()
  })
})

describe("extractAppName", () => {
  it("reads the app name from the app layout loader data", () => {
    const matches: Array<MatchWithLoader> = [
      { routeId: "/_authed/apps", loaderData: {} },
      {
        routeId: "/_authed/apps/$id",
        loaderData: { app: { name: "Ploydok API" } },
      },
    ]

    expect(extractAppName(matches)).toBe("Ploydok API")
  })

  it("returns null when there is no app loader match", () => {
    expect(extractAppName([])).toBeNull()
  })
})

describe("resolveTopbarBreadcrumb", () => {
  it("prefixes the dashboard with the Workspace group", () => {
    expect(resolveTopbarBreadcrumb("/dashboard", null)).toEqual([
      { label: "Workspace" },
      { label: "Dashboard" },
    ])
  })

  it("builds the root settings breadcrumb without a sidebar group", () => {
    expect(resolveTopbarBreadcrumb("/settings", null)).toEqual([
      { label: "Settings" },
    ])
  })

  it("builds the nested git provider breadcrumb under Integrations", () => {
    expect(
      resolveTopbarBreadcrumb("/settings/git-providers/github", null)
    ).toEqual([
      { label: "Integrations" },
      { label: "Git providers", to: "/settings/git-providers" },
      { label: "GitHub" },
    ])
  })

  it("builds the nested security breadcrumb", () => {
    expect(resolveTopbarBreadcrumb("/settings/security/passkey", null)).toEqual(
      [
        { label: "Settings", to: "/settings" },
        { label: "Security", to: "/settings/security" },
        { label: "Passkeys" },
      ]
    )
  })

  it("builds the posture security breadcrumb", () => {
    expect(resolveTopbarBreadcrumb("/settings/security/posture", null)).toEqual(
      [
        { label: "Settings", to: "/settings" },
        { label: "Security", to: "/settings/security" },
        { label: "Posture" },
      ]
    )
  })

  it("builds the apps list breadcrumb under Workspace", () => {
    expect(resolveTopbarBreadcrumb("/apps", null)).toEqual([
      { label: "Workspace" },
      { label: "Applications" },
    ])
  })

  it("builds the app breadcrumb with the dynamic app name", () => {
    expect(
      resolveTopbarBreadcrumb("/apps/app-123/deployments", "Billing API")
    ).toEqual([
      { label: "Workspace" },
      { label: "Applications", to: "/apps" },
      { label: "Billing API", to: "/apps/app-123/settings" },
      { label: "Deployments" },
    ])
  })

  it("treats the app general settings as the current page", () => {
    expect(
      resolveTopbarBreadcrumb("/apps/app-123/settings", "Billing API")
    ).toEqual([
      { label: "Workspace" },
      { label: "Applications", to: "/apps" },
      { label: "Billing API", to: "/apps/app-123/settings" },
      { label: "General" },
    ])
  })

  it("builds the databases breadcrumb for org-scoped routes", () => {
    expect(resolveTopbarBreadcrumb("/orgs/acme/databases", null)).toEqual([
      { label: "Workspace" },
      { label: "Databases" },
    ])
  })

  it("builds the database detail breadcrumb with the id", () => {
    expect(resolveTopbarBreadcrumb("/databases/db-123", null)).toEqual([
      { label: "Workspace" },
      { label: "Databases", to: "/databases" },
      { label: "db-123" },
    ])
  })

  it("builds the services breadcrumb under Workspace", () => {
    expect(resolveTopbarBreadcrumb("/services", null)).toEqual([
      { label: "Workspace" },
      { label: "Services" },
    ])
  })

  it("builds the service detail breadcrumb with the id", () => {
    expect(resolveTopbarBreadcrumb("/services/svc-1", null)).toEqual([
      { label: "Workspace" },
      { label: "Services", to: "/services" },
      { label: "svc-1" },
    ])
  })

  it("falls back to the app id when no name is loaded", () => {
    expect(resolveTopbarBreadcrumb("/apps/app-xyz", null)).toEqual([
      { label: "Workspace" },
      { label: "Applications", to: "/apps" },
      { label: "app-xyz" },
    ])
  })

  it("builds the monitoring breadcrumb under Workspace", () => {
    expect(resolveTopbarBreadcrumb("/monitoring", null)).toEqual([
      { label: "Workspace" },
      { label: "Monitoring" },
    ])
  })

  it("builds the marketplace breadcrumb under Workspace", () => {
    expect(resolveTopbarBreadcrumb("/orgs/acme/marketplace", null)).toEqual([
      { label: "Workspace" },
      { label: "Marketplace" },
    ])
  })

  it("builds new workspace-group breadcrumbs", () => {
    expect(resolveTopbarBreadcrumb("/orgs/acme/deployments", null)).toEqual([
      { label: "Workspace" },
      { label: "Deployments" },
    ])
  })

  it("builds platform-group breadcrumbs", () => {
    expect(resolveTopbarBreadcrumb("/members", null)).toEqual([
      { label: "Platform" },
      { label: "Members" },
    ])
    expect(resolveTopbarBreadcrumb("/audit", null)).toEqual([
      { label: "Platform" },
      { label: "Audit" },
    ])
    expect(resolveTopbarBreadcrumb("/shared-env", null)).toEqual([
      { label: "Platform" },
      { label: "Shared env" },
    ])
    expect(resolveTopbarBreadcrumb("/scheduled-jobs", null)).toEqual([
      { label: "Platform" },
      { label: "Scheduled jobs" },
    ])
    expect(resolveTopbarBreadcrumb("/event-webhooks", null)).toEqual([
      { label: "Platform" },
      { label: "Event webhooks" },
    ])
    expect(resolveTopbarBreadcrumb("/tags", null)).toEqual([
      { label: "Platform" },
      { label: "Tags" },
    ])
  })

  it("prefixes workspace links with the org slug on org-scoped routes", () => {
    expect(
      resolveTopbarBreadcrumb("/orgs/acme/services/svc-1", null, "acme")
    ).toEqual([
      { label: "Workspace" },
      { label: "Services", to: "/orgs/acme/services" },
      { label: "svc-1" },
    ])
    expect(
      resolveTopbarBreadcrumb(
        "/orgs/acme/apps/app-123/settings",
        "Billing API",
        "acme"
      )
    ).toEqual([
      { label: "Workspace" },
      { label: "Applications", to: "/orgs/acme/apps" },
      { label: "Billing API", to: "/orgs/acme/apps/app-123/settings" },
      { label: "General" },
    ])
  })

  it("returns no breadcrumb for routes outside the supported topbar map", () => {
    expect(resolveTopbarBreadcrumb("/login", null)).toEqual([])
  })
})
