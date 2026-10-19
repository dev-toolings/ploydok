// SPDX-License-Identifier: AGPL-3.0-only

import i18n from "../../lib/i18n"

export interface MatchWithLoader {
  routeId?: string
  params?: Record<string, string | undefined>
  loaderData?: unknown
}

function findAppMatch(
  matches: ReadonlyArray<MatchWithLoader>
): MatchWithLoader | undefined {
  return matches.find(
    (m) =>
      m.routeId === "/_authed/apps/$id" ||
      m.routeId === "/_authed/orgs/$orgSlug/apps/$id"
  )
}

export function extractAppId(
  matches: ReadonlyArray<MatchWithLoader>
): string | null {
  const appMatch = findAppMatch(matches)
  if (!appMatch) return null
  const data = appMatch.loaderData as
    { app?: { id?: string | null } } | undefined
  return data?.app?.id ?? appMatch.params?.id ?? null
}

export interface BreadcrumbItem {
  label: string
  to?: string
}

export function extractAppName(
  matches: ReadonlyArray<MatchWithLoader>
): string | null {
  const appMatch = findAppMatch(matches)
  if (!appMatch) return null
  const data = appMatch.loaderData as
    { app?: { name?: string | null } } | undefined
  return data?.app?.name ?? null
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/"
  return pathname.endsWith("/") ? pathname.slice(0, -1) || "/" : pathname
}

function humanizeSegment(segment: string): string {
  return segment
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function navLabel(id: string): string {
  return i18n.t(`common:nav.${id}`)
}

function navItem(id: string, to?: string): BreadcrumbItem {
  return to === undefined
    ? { label: navLabel(id) }
    : { label: navLabel(id), to }
}

export function resolveTopbarBreadcrumb(
  pathname: string,
  appName: string | null,
  orgSlug?: string | null
): Array<BreadcrumbItem> {
  let normalized = normalizePathname(pathname)
  let isOrgScoped = false
  if (normalized.startsWith("/orgs/")) {
    isOrgScoped = true
    const parts = normalized.split("/").filter(Boolean)
    if (!orgSlug) orgSlug = parts[1] ?? null
    normalized =
      parts.length > 2 ? `/${parts.slice(2).join("/")}` : "/dashboard"
  }
  const orgPrefix = isOrgScoped && orgSlug ? `/orgs/${orgSlug}` : ""
  const ws = (path: string) => `${orgPrefix}${path}`
  const workspace = navItem("workspace")
  const platform = navItem("platform")
  const integrations = navItem("integrations")

  if (normalized === "/dashboard") {
    return [workspace, navItem("dashboard")]
  }

  if (normalized === "/guide") {
    return [navItem("guide")]
  }

  if (normalized === "/changelog") {
    return [navItem("changelog")]
  }

  if (normalized === "/monitoring") {
    return [workspace, navItem("monitoring")]
  }

  if (normalized === "/marketplace") {
    return [workspace, navItem("marketplace")]
  }

  if (normalized === "/deployments") {
    return [workspace, navItem("deployments")]
  }

  if (normalized === "/settings") {
    return [navItem("settings")]
  }

  if (normalized.startsWith("/settings/")) {
    const segments = normalized.split("/").filter(Boolean).slice(1)
    const items: Array<BreadcrumbItem> = [navItem("settings", "/settings")]

    if (segments[0] === "security") {
      items.push(navItem("security", "/settings/security"))
      const securityLabels: Record<string, string> = {
        passkey: "Passkeys",
        passkeys: "Passkeys",
        posture: "Posture",
        sessions: "Sessions",
        totp: "TOTP",
      }
      const child = segments[1]
      if (child) {
        items.push({ label: securityLabels[child] ?? humanizeSegment(child) })
      } else {
        items[items.length - 1] = navItem("security")
      }
      return items
    }

    if (
      segments[0] === "git-providers" ||
      segments[0] === "registry" ||
      segments[0] === "notifications" ||
      segments[0] === "api-tokens"
    ) {
      items[0] = integrations
    }

    if (segments[0] === "git-providers") {
      items.push(navItem("gitProviders", "/settings/git-providers"))
      const providerLabels: Record<string, string> = {
        github: "GitHub",
        gitlab: "GitLab",
      }
      const child = segments[1]
      if (child) {
        items.push({ label: providerLabels[child] ?? humanizeSegment(child) })
      } else {
        items[items.length - 1] = navItem("gitProviders")
      }
      return items
    }

    if (segments[0] === "registry") {
      items.push(navItem("registry"))
      return items
    }

    if (segments[0] === "notifications") {
      items.push(navItem("notifications"))
      return items
    }

    if (segments[0] === "api-tokens") {
      items.push(navItem("apiTokens"))
      return items
    }

    items.push({ label: humanizeSegment(segments[0] ?? "") })
    return items
  }

  if (normalized === "/apps") {
    return [workspace, navItem("applications")]
  }

  if (normalized === "/databases") {
    return [workspace, navItem("databases")]
  }

  if (normalized === "/members") {
    return [platform, navItem("members")]
  }

  if (normalized === "/audit") {
    return [platform, navItem("audit")]
  }

  if (normalized === "/disk") {
    return [navItem("instance"), navItem("disk")]
  }

  if (normalized === "/shared-env") {
    return [platform, navItem("sharedEnv")]
  }

  if (normalized === "/scheduled-jobs") {
    return [platform, navItem("scheduledJobs")]
  }

  if (normalized === "/event-webhooks") {
    return [platform, navItem("eventWebhooks")]
  }

  if (normalized === "/tags") {
    return [platform, navItem("tags")]
  }

  if (normalized === "/branding") {
    return [platform, { label: "Branding" }]
  }

  if (normalized.startsWith("/databases/")) {
    const segments = normalized.split("/").filter(Boolean)
    const dbId = segments[1]
    if (!dbId) return [workspace, navItem("databases")]
    return [workspace, navItem("databases", ws("/databases")), { label: dbId }]
  }

  if (normalized === "/services") {
    return [workspace, navItem("services")]
  }

  if (normalized.startsWith("/services/")) {
    const segments = normalized.split("/").filter(Boolean)
    const serviceId = segments[1]
    if (!serviceId) return [workspace, navItem("services")]
    return [
      workspace,
      navItem("services", ws("/services")),
      { label: serviceId },
    ]
  }

  if (normalized.startsWith("/apps/")) {
    const segments = normalized.split("/").filter(Boolean)
    const items: Array<BreadcrumbItem> = [
      workspace,
      navItem("applications", ws("/apps")),
    ]
    const appId = segments[1]
    if (!appId) return items

    items.push({
      label: appName ?? appId,
      to: ws(`/apps/${appId}/settings`),
    })

    const appTabLabels: Record<string, string> = {
      deployments: navLabel("deployments"),
      logs: "Logs",
      shell: "Shell",
      settings: "General",
      advanced: "Advanced",
      env: "Env",
      domains: "Domains",
    }
    const child = segments[2]
    if (child) {
      items.push({ label: appTabLabels[child] ?? humanizeSegment(child) })
    } else {
      items[items.length - 1] = { label: appName ?? appId }
    }
    return items
  }

  return []
}
