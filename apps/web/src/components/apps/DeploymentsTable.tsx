// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { RiLoader4Line, RiMoreLine } from "@remixicon/react"
import { DataTable } from "@workspace/ui/components/data-table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog"
import i18n from "../../lib/i18n"
import type { TFunction } from "i18next"
import type { ColumnDef } from "@workspace/ui/components/data-table"
import type { Build, BuildStatus } from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUILD_STATUS_CLASS: Record<BuildStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff]",
  succeeded: "bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]",
  succeeded_with_warning: "bg-warn-100 dark:bg-[#432004]/60 text-warn-700 dark:text-[#fdc700]",
  failed: "bg-neg-100 dark:bg-[#4d0218]/60 text-neg-700 dark:text-[#ff637e]",
  cancelled: "bg-muted text-muted-foreground",
}

const BUILD_STATUS_KEY: Record<BuildStatus, string> = {
  pending: "deployments.statusPending",
  running: "deployments.statusRunning",
  succeeded: "deployments.statusSucceeded",
  succeeded_with_warning: "deployments.statusWarning",
  failed: "deployments.statusFailed",
  cancelled: "deployments.statusCancelled",
}

const IN_PROGRESS_STATUSES: ReadonlySet<BuildStatus> = new Set([
  "pending",
  "running",
])

const BUILD_METHOD_LABEL: Record<string, string> = {
  docker: "Dockerfile",
  dockerfile: "Dockerfile",
  compose: "Compose",
  nixpacks: "Nixpacks",
  railpack: "Railpack",
}

const BUILD_METHOD_CLASS: Record<string, string> = {
  docker: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff]",
  dockerfile: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff]",
  compose: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff]",
  nixpacks: "bg-violet-100 dark:bg-[#2f0d68]/60 text-violet-700 dark:text-[#a684ff]",
  railpack: "bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]",
}

const TRIGGER_SOURCE_KEY: Record<string, string> = {
  api: "deployments.sources.api",
  "webhook:github": "deployments.sources.github",
  "webhook:gitlab": "deployments.sources.gitlab",
  "auto:push": "deployments.sources.autoPush",
  "auto:tag": "deployments.sources.autoTag",
  "cron:gc": "deployments.sources.cleanup",
  "cron:cleanup": "deployments.sources.cleanup",
  system: "deployments.sources.system",
}

const TRIGGER_SOURCE_CLASS: Record<string, string> = {
  api: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff]",
  "webhook:github": "bg-neutral-500/10 text-neutral-700 dark:text-neutral-300",
  "webhook:gitlab": "bg-orange-100 dark:bg-[#441306]/60 text-orange-800 dark:text-[#ff8904]",
  "auto:push": "bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]",
  "auto:tag": "bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]",
  "cron:gc": "bg-warn-100 dark:bg-[#432004]/60 text-warn-700 dark:text-[#fdc700]",
  "cron:cleanup": "bg-warn-100 dark:bg-[#432004]/60 text-warn-700 dark:text-[#fdc700]",
  system: "bg-muted text-muted-foreground",
}

export function formatDuration(startMs?: number, endMs?: number): string {
  if (!startMs) return "—"
  const diff = ((endMs ?? Date.now()) - startMs) / 1000
  if (diff < 60) return `${Math.round(diff)}s`
  const m = Math.floor(diff / 60)
  const s = Math.round(diff % 60)
  return `${m}m ${s}s`
}

/** Truncate text to `maxLen` chars, appending "…" if needed. */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + "…"
}

export function formatBuildTriggerSource(source?: string | null): string {
  if (!source) return i18n.t("apps:deployments.sources.unknown")
  const key = TRIGGER_SOURCE_KEY[source]
  return key ? i18n.t(`apps:${key}`) : source
}

function triggerSourceClass(source?: string | null): string {
  if (!source) return "bg-muted text-muted-foreground"
  return TRIGGER_SOURCE_CLASS[source] ?? "bg-muted text-muted-foreground"
}

function shortenUserId(userId?: string | null): string | null {
  if (!userId) return null
  return userId.length > 8 ? userId.slice(0, 8) : userId
}

// Live-ticking duration cell. `formatDuration` reads `Date.now()` when the
// build has no `finishedAt`, but React only re-renders on state changes —
// so without a ticker the column was frozen until the next SSE-driven
// refetch. A per-row 1s interval (only enabled while the build is in
// progress) keeps the displayed value coherent with the wall clock.
function LiveDurationCell({
  startedAt,
  finishedAt,
  inProgress,
}: {
  startedAt?: number
  finishedAt?: number
  inProgress: boolean
}): React.JSX.Element {
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    if (!inProgress) return
    const id = setInterval(forceTick, 1000)
    return () => clearInterval(id)
  }, [inProgress])

  return (
    <span className="text-muted-foreground">
      {formatDuration(startedAt, finishedAt)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DeploymentApplication {
  id: string
  name: string
  slug: string
}

export type DeploymentTableBuild = Build & {
  app?: DeploymentApplication
}

export interface DeploymentsTableProps {
  builds: Array<DeploymentTableBuild>
  /** Called when user clicks "View logs" on a build. */
  onSelectBuild: (buildId: string) => void
  /** Called when user confirms rollback on a build. */
  onRollback: (build: Build) => void
  /** Called when user confirms cancel on an in-progress build. */
  onCancel?: (build: Build) => void
  /** Loading state — shows skeleton rows when true. */
  isLoading?: boolean
  /** Adds the owning application column for workspace-wide deployment lists. */
  showApplication?: boolean
  /** Builds an application deployments URL for the application column. */
  appDeploymentsHref?: (app: DeploymentApplication) => string
  /** Disables client-side pagination when the API already paginates rows. */
  paginate?: boolean
  /** Hides mutating actions for workspace members without owner rights. */
  canManage?: boolean
  /** Renders edge to edge inside a bordered table card. */
  flush?: boolean
}

// ---------------------------------------------------------------------------
// Row actions cell
// ---------------------------------------------------------------------------

interface RowActionsProps {
  build: Build
  onSelectBuild: (id: string) => void
  onRollback: (build: Build) => void
  onCancel?: (build: Build) => void
  canManage: boolean
}

function RowActions({
  build,
  onSelectBuild,
  onRollback,
  onCancel,
  canManage,
}: RowActionsProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const canRollback =
    build.status === "succeeded" || build.status === "succeeded_with_warning"
  const canCancel = IN_PROGRESS_STATUSES.has(build.status)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none"
          aria-label={t("deployments.rowActions")}
        >
          <RiMoreLine className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onSelectBuild(build.id)}>
          {t("deployments.viewLogs")}
        </DropdownMenuItem>
        {canManage ? <DropdownMenuSeparator /> : null}
        {canManage && canCancel && onCancel ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                {t("deployments.cancelDeployment")}
              </DropdownMenuItem>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("deployments.cancelConfirm")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("deployments.cancelBody", { id: build.id.slice(0, 8) })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("deployments.keepRunning")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => onCancel(build)}
                >
                  {t("deployments.cancelDeployment")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
        {canManage && canRollback ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                {t("deployments.rollbackToThis")}
              </DropdownMenuItem>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("deployments.rollbackConfirm")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("deployments.rollbackBody", {
                    id: build.id.slice(0, 8),
                    commit: build.commitSha
                      ? ` (${build.commitSha.slice(0, 7)})`
                      : "",
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => onRollback(build)}
                >
                  {t("actions.rollback")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : canManage ? (
          <DropdownMenuItem disabled>
            {t("deployments.rollbackUnavailable")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

function makeColumns(
  t: TFunction,
  onSelectBuild: (id: string) => void,
  onRollback: (build: Build) => void,
  onCancel?: (build: Build) => void,
  showApplication = false,
  appDeploymentsHref?: (app: DeploymentApplication) => string,
  canManage = true
): Array<ColumnDef<DeploymentTableBuild>> {
  const applicationColumn: Array<ColumnDef<DeploymentTableBuild>> =
    showApplication
      ? [
          {
            id: "application",
            header: t("deployments.application"),
            cell: ({ row }) => {
              const app = row.original.app
              if (!app) {
                return <span className="text-muted-foreground">—</span>
              }
              const href = appDeploymentsHref?.(app)
              return href ? (
                <a
                  href={href}
                  onClick={(event) => event.stopPropagation()}
                  className="font-medium text-foreground hover:text-primary hover:underline"
                >
                  {app.name}
                </a>
              ) : (
                <span className="font-medium text-foreground">{app.name}</span>
              )
            },
          },
        ]
      : []

  return [
    ...applicationColumn,
    {
      id: "commit",
      header: t("deployments.commit"),
      cell: ({ row }) => {
        const sha = row.original.commitSha
        const msg = row.original.commitMessage
        return (
          <div className="flex min-w-0 flex-col gap-0.5">
            {sha ? (
              <span className="font-mono">{sha.slice(0, 7)}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
            {msg ? (
              <span
                className="max-w-[240px] truncate text-muted-foreground"
                title={msg}
              >
                {truncate(msg, 60)}
              </span>
            ) : null}
          </div>
        )
      },
    },
    {
      id: "status",
      header: t("common:status"),
      cell: ({ row }) => {
        const status = row.original.status
        const inProgress = IN_PROGRESS_STATUSES.has(status)
        return (
          <span
            className={[
              "inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
              BUILD_STATUS_CLASS[status],
            ].join(" ")}
          >
            {inProgress && (
              <RiLoader4Line
                className="size-3 animate-spin"
                aria-hidden="true"
              />
            )}
            {t(BUILD_STATUS_KEY[status])}
          </span>
        )
      },
    },
    {
      id: "duration",
      header: t("deployments.duration"),
      cell: ({ row }) => {
        const inProgress = IN_PROGRESS_STATUSES.has(row.original.status)
        return (
          <LiveDurationCell
            startedAt={row.original.startedAt}
            finishedAt={row.original.finishedAt}
            inProgress={inProgress}
          />
        )
      },
    },
    {
      id: "method",
      header: t("deployments.method"),
      cell: ({ row }) => {
        const method = row.original.buildMethod
        if (!method) {
          return <span className="text-muted-foreground">—</span>
        }
        const label = BUILD_METHOD_LABEL[method] ?? method
        const cls =
          BUILD_METHOD_CLASS[method] ?? "bg-muted text-muted-foreground"
        return (
          <span
            className={[
              "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
              cls,
            ].join(" ")}
          >
            {label}
          </span>
        )
      },
    },
    {
      id: "triggered-by",
      header: t("deployments.triggeredBy"),
      cell: ({ row }) => {
        const source = row.original.source
        const requestedBy = shortenUserId(row.original.requestedByUserId)
        return (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <span
              className={[
                "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium",
                triggerSourceClass(source),
              ].join(" ")}
            >
              {formatBuildTriggerSource(source)}
            </span>
            {requestedBy ? (
              <span
                className="font-mono text-xs text-muted-foreground"
                title={row.original.requestedByUserId ?? undefined}
              >
                {requestedBy}
              </span>
            ) : null}
          </div>
        )
      },
    },
    {
      id: "started",
      header: t("deployments.started"),
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.startedAt
            ? new Date(row.original.startedAt).toLocaleString()
            : "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          <RowActions
            build={row.original}
            onSelectBuild={onSelectBuild}
            onRollback={onRollback}
            onCancel={onCancel}
            canManage={canManage}
          />
        </div>
      ),
    },
  ]
}

// ---------------------------------------------------------------------------
// DeploymentsTable
// ---------------------------------------------------------------------------

export function DeploymentsTable({
  builds,
  onSelectBuild,
  onRollback,
  onCancel,
  isLoading,
  showApplication,
  appDeploymentsHref,
  canManage = true,
  paginate = true,
  flush = false,
}: DeploymentsTableProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const columns = React.useMemo(
    () =>
      makeColumns(
        t,
        onSelectBuild,
        onRollback,
        onCancel,
        showApplication,
        appDeploymentsHref,
        canManage
      ),
    [
      t,
      onSelectBuild,
      onRollback,
      onCancel,
      showApplication,
      appDeploymentsHref,
      canManage,
    ]
  )

  if (isLoading) {
    return <DeploymentsTableSkeleton />
  }

  if (builds.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-panel-border bg-panel-inset py-16 text-center">
        <p className="mb-1 text-sm font-medium">{t("empty.noDeployments")}</p>
        <p className="text-sm text-muted-foreground">
          {t("deployments.emptyHint")}
        </p>
      </div>
    )
  }

  return (
    <DataTable<DeploymentTableBuild>
      columns={columns}
      rows={builds}
      pageSize={10}
      onRowClick={(build) => onSelectBuild(build.id)}
      paginate={paginate}
      flush={flush}
    />
  )
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function DeploymentsTableSkeleton(): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="h-10 skeleton-surface" />
      {[...Array<null>(4)].map((_, i) => (
        <div key={i} className="flex gap-4 border-t border-border/60 px-4 py-3">
          <div className="h-4 w-16 skeleton-surface rounded" />
          <div className="h-4 w-20 skeleton-surface rounded" />
          <div className="h-4 w-12 skeleton-surface rounded" />
          <div className="h-4 w-24 skeleton-surface rounded" />
        </div>
      ))}
    </div>
  )
}
