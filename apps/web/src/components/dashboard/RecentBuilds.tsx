// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  organizationPath,
  useCurrentOrganizationSlug,
} from "../../lib/organizations"
import i18n from "../../lib/i18n"
import type { BuildStatus } from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildRow {
  buildId: string
  appId: string
  appName: string
  status: BuildStatus
  commitSha?: string
  startedAt?: number
  createdAt: number
}

interface RecentBuildsProps {
  builds: Array<BuildRow>
  isLoading: boolean
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

const STATUS_DOT: Record<BuildStatus, string> = {
  pending: "bg-muted-foreground",
  running: "bg-blue-500 animate-pulse",
  succeeded: "bg-green-500",
  succeeded_with_warning: "bg-amber-500",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
}

const STATUS_TEXT: Record<BuildStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-blue-600 dark:text-blue-400",
  succeeded: "text-green-600 dark:text-green-400",
  succeeded_with_warning: "text-amber-600 dark:text-amber-400",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
}

function timeAgo(tsMs: number): string {
  const diff = Date.now() - tsMs
  const s = Math.floor(diff / 1000)
  if (s < 60) return i18n.t("common:relative.secondsAgo", { count: s })
  const m = Math.floor(s / 60)
  if (m < 60) return i18n.t("common:relative.minutesAgo", { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return i18n.t("common:relative.hoursAgo", { count: h })
  return i18n.t("common:relative.daysAgo", { count: Math.floor(h / 24) })
}

// ---------------------------------------------------------------------------
// RecentBuilds
// ---------------------------------------------------------------------------

export function RecentBuilds({
  builds,
  isLoading,
}: RecentBuildsProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-muted-foreground">
        {t("dashboard.recentBuilds")}
      </p>
      {isLoading ? (
        <RecentBuildsSkeleton />
      ) : builds.length === 0 ? (
        <div className="rounded-lg border border-dashed border-panel-border bg-panel-inset py-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("dashboard.noBuildsYet")}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-2xl bg-panel">
          {builds.slice(0, 5).map((build) => (
            <BuildItem key={build.buildId} build={build} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// BuildItem
// ---------------------------------------------------------------------------

function BuildItem({ build }: { build: BuildRow }): React.JSX.Element {
  const ts = build.startedAt ?? build.createdAt
  const sha = build.commitSha ? build.commitSha.slice(0, 7) : null
  const orgSlug = useCurrentOrganizationSlug()

  return (
    <Link
      to={
        (orgSlug
          ? organizationPath(orgSlug, `apps/${build.appId}/settings`)
          : `/apps/${build.appId}/settings`) as never
      }
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
    >
      {/* Status dot */}
      <span
        className={[
          "size-2 shrink-0 rounded-full",
          STATUS_DOT[build.status],
        ].join(" ")}
        aria-hidden="true"
      />

      {/* Info */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">
          <span className={STATUS_TEXT[build.status]}>{build.appName}</span>
          {sha && (
            <span className="font-mono text-muted-foreground"> · {sha}</span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{timeAgo(ts)}</p>
      </div>

      {/* Status label */}
      <span
        className={[
          "shrink-0 text-xs font-medium",
          STATUS_TEXT[build.status],
        ].join(" ")}
      >
        {build.status}
      </span>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function RecentBuildsSkeleton(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  return (
    <div
      className="divide-y divide-border overflow-hidden rounded-2xl bg-panel"
      aria-busy="true"
      aria-label={t("dashboard.loadingRecentBuilds")}
    >
      {[...Array<null>(4)].map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-2 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-16" />
          </div>
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </div>
  )
}
