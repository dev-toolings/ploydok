// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { useTranslation } from "react-i18next"
import { AppStatusBadge } from "../apps/AppStatusBadge"
import { AppIcon } from "../apps/AppIcon"
import {
  resolveAppHealth,
  resolveRuntimeAppStatus,
  selectAppSnapshot,
} from "../../lib/app-runtime"
import { useMonitoring } from "../../lib/monitoring"
import {
  organizationPath,
  useCurrentOrganizationSlug,
} from "../../lib/organizations"
import type { AppHealth } from "../../lib/app-runtime"
import type { AppListItem } from "../../lib/apps"

// ---------------------------------------------------------------------------
// AppsGrid
// ---------------------------------------------------------------------------

interface AppsGridProps {
  apps: Array<AppListItem>
  isLoading: boolean
  onCreateApp: () => void
}

export function AppsGrid({
  apps,
  isLoading,
  onCreateApp,
}: AppsGridProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const { data: monitoring } = useMonitoring()
  const containers = monitoring?.containers ?? []

  if (isLoading) {
    return <AppsGridSkeleton />
  }

  if (apps.length === 0) {
    return <AppsEmptyState onCreateApp={onCreateApp} />
  }

  // Sort by updatedAt desc, take 6
  const recent = [...apps]
    .map((app) => {
      const snapshot = selectAppSnapshot(containers, app.id, app.containerId)
      return {
        ...app,
        runtimeStatus: resolveRuntimeAppStatus(app.status, snapshot),
        runtimeHealth: resolveAppHealth(snapshot),
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("dashboard.recentApps")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {recent.map((app) => (
          <AppMiniCard key={app.id} app={app} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AppMiniCard
// ---------------------------------------------------------------------------

function AppMiniCard({
  app,
}: {
  app: AppListItem & {
    runtimeStatus: AppListItem["status"]
    runtimeHealth: AppHealth | null
  }
}): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const orgSlug = useCurrentOrganizationSlug()
  const isDeleting = app.status === "deleting"
  const quickLinks = (app.quickLinks ?? []).slice(0, 2)
  const settingsPath = orgSlug
    ? organizationPath(orgSlug, `apps/${app.id}/settings`)
    : `/apps/${app.id}/settings`
  const content = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <AppIcon name={app.name} src={app.iconUrl} className="size-8" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{app.name}</p>
            {app.repoFullName || app.imageRef ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {app.repoFullName ?? app.imageRef}
              </p>
            ) : null}
          </div>
        </div>
        <AppStatusBadge status={app.runtimeStatus} health={app.runtimeHealth} />
      </div>
      {app.branch && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <BranchIcon className="size-3 shrink-0" />
          <span className="truncate">{app.branch}</span>
        </div>
      )}
      {isDeleting ? (
        <p className="text-xs text-muted-foreground">
          {t("dashboard.deletionInProgress")}
        </p>
      ) : null}
    </>
  )

  if (isDeleting) {
    return (
      <div
        className="block cursor-not-allowed space-y-2 rounded-lg border border-border bg-muted/30 p-4 opacity-60"
        aria-disabled="true"
      >
        {content}
      </div>
    )
  }

  return (
    <article className="overflow-hidden rounded-2xl bg-panel transition-colors hover:border-muted-foreground/30">
      <Link
        to={settingsPath as never}
        className="block space-y-2 p-4 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {content}
      </Link>
      {quickLinks.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
          {quickLinks.map((link) => (
            <a
              key={`${link.label}-${link.url}`}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function AppsEmptyState({
  onCreateApp,
}: {
  onCreateApp: () => void
}): React.JSX.Element {
  const { t } = useTranslation("workspace")
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-panel-border bg-panel-inset py-10 text-center">
      <div className="mb-3 rounded-full bg-muted p-3">
        <GridIcon className="size-5 text-muted-foreground" />
      </div>
      <p className="mb-1 text-sm font-medium">{t("dashboard.noAppsYet")}</p>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("dashboard.createFirstApp")}
      </p>
      <button
        type="button"
        onClick={onCreateApp}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {t("dashboard.newApp")}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function AppsGridSkeleton(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  return (
    <div className="space-y-3" aria-busy="true" aria-label={t("dashboard.loadingApps")}>
      <Skeleton className="h-3.5 w-24" />
      <div className="grid gap-3 sm:grid-cols-2">
        {[...Array<null>(4)].map((_, i) => (
          <div key={i} className="space-y-2 rounded-2xl bg-panel p-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function BranchIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

function GridIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </svg>
  )
}
