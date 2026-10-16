// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  RiArrowLeftSLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiGitBranchLine,
} from "@remixicon/react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@workspace/ui/components/chart"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import { AppIcon } from "../apps/AppIcon"
import { AppStatusBadge } from "../apps/AppStatusBadge"
import { DeploymentsTable } from "../apps/DeploymentsTable"
import i18n from "../../lib/i18n"
import {
  formatDuration,
  relativeChange,
  successRate,
  useDeploymentActivity,
  useDeploymentWindows,
} from "../../lib/dashboard-insights"
import { useHostStats } from "../../lib/host-stats"
import { organizationPath } from "../../lib/organizations"
import {
  useWorkspaceDeploymentActions,
  useWorkspaceDeployments,
} from "../../lib/workspace-deployments"
import type { ChartConfig } from "@workspace/ui/components/chart"
import type { AppStatus, Build, DeploymentActivityRange } from "@ploydok/shared"
import type { AppListItem } from "../../lib/apps"

// BoardUI card surface: 16px radius, panel fill, 16px padding.
const CARD = "flex min-w-0 flex-col rounded-2xl bg-panel p-4"

function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-sm font-medium text-muted-foreground">
      {children}
    </span>
  )
}

function BigNumber({ children }: { children: React.ReactNode }) {
  return (
    <span className="truncate text-2xl leading-[34px] font-medium text-foreground tabular-nums">
      {children}
    </span>
  )
}

/** Change badge; `inverse` when a drop is good news (build time). */
function DeltaBadge({
  value,
  inverse = false,
}: {
  value: number | null
  inverse?: boolean
}) {
  if (value === null) return null
  const rounded = Math.round(value * 10) / 10
  const good = inverse ? rounded < 0 : rounded > 0
  const variant = rounded === 0 ? "secondary" : good ? "success" : "destructive"
  return (
    <Badge variant={variant} className="h-6 px-1.5 text-sm tabular-nums">
      {rounded > 0 ? "+" : ""}
      {rounded.toFixed(1)}%
    </Badge>
  )
}

function Skeleton({ className }: { className: string }) {
  return (
    <div aria-hidden="true" className={cn("skeleton-surface rounded", className)} />
  )
}

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------

export function KpiCard({
  icon,
  label,
  value,
  delta,
  hint,
  loading = false,
  inverse = false,
}: {
  icon: React.ReactNode
  label: string
  value: string
  delta?: number | null
  hint?: string
  loading?: boolean
  inverse?: boolean
}) {
  return (
    <div className={cn(CARD, "h-full min-h-[132px] justify-between gap-3")}>
      <span className="flex w-fit items-center rounded-md bg-panel-inset p-1.5 text-foreground dark:bg-neutral-800 [&_svg]:size-5">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <CardLabel>{label}</CardLabel>
        {loading ? (
          <>
            <Skeleton className="my-[3px] h-7 w-24" />
            <Skeleton className="my-[3px] h-3 w-32" />
          </>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <BigNumber>{value}</BigNumber>
              <DeltaBadge value={delta ?? null} inverse={inverse} />
            </div>
            <span className="truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
              {hint ?? "\u00a0"}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

export function useKpis(orgSlug: string) {
  const week = useDeploymentWindows(orgSlug, 7)
  const month = useDeploymentWindows(orgSlug, 30)
  const rate = month.data ? successRate(month.data.current) : null
  const previousRate = month.data ? successRate(month.data.previous) : null
  return {
    loading: week.isLoading || month.isLoading,
    deploys: week.data?.current.total ?? 0,
    deploysDelta: week.data
      ? relativeChange(week.data.current.total, week.data.previous.total)
      : null,
    rate,
    rateDelta: relativeChange(rate, previousRate),
    median: month.data?.current.medianDurationMs ?? null,
    medianDelta: month.data
      ? relativeChange(
          month.data.current.medianDurationMs,
          month.data.previous.medianDurationMs
        )
      : null,
  }
}

export function formatKpiDuration(ms: number | null): string {
  return ms === null ? "–" : formatDuration(ms)
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 items-start gap-0.5 rounded-[10px] bg-panel-inset/60 p-1 dark:bg-neutral-900"
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "cursor-pointer rounded-md px-2.5 py-1 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-background font-medium text-foreground shadow-[0_1px_2px_0_#0000000d] dark:bg-neutral-800"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Deployment activity chart
// ---------------------------------------------------------------------------

const RANGES: ReadonlyArray<DeploymentActivityRange> = [7, 30, 90]

export function DeploymentActivityCard({ orgSlug }: { orgSlug: string }) {
  const { t } = useTranslation("workspace")
  const [days, setDays] = React.useState<DeploymentActivityRange>(30)
  const activity = useDeploymentActivity(orgSlug, days)
  const windows = useDeploymentWindows(orgSlug, days)
  const buckets = activity.data?.buckets ?? []
  const total = buckets.reduce(
    (sum, bucket) => sum + bucket.succeeded + bucket.failed + bucket.other,
    0
  )
  const delta = windows.data
    ? relativeChange(windows.data.current.total, windows.data.previous.total)
    : null

  const config = {
    succeeded: {
      label: t("dashboard.activity.succeeded"),
      color: "var(--color-viz-400)",
    },
    failed: {
      label: t("dashboard.activity.failed"),
      color: "var(--color-neg-600)",
    },
    other: {
      label: t("dashboard.activity.other"),
      color: "var(--color-chart-5)",
    },
  } satisfies ChartConfig

  const formatDay = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(i18n.resolvedLanguage, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })

  return (
    <section className={cn(CARD, "gap-3")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <CardLabel>{t("dashboard.activity.title")}</CardLabel>
          {activity.isLoading ? (
            <Skeleton className="mt-1 h-7 w-20" />
          ) : (
            <div className="flex items-center gap-2">
              <BigNumber>{total}</BigNumber>
              <DeltaBadge value={delta} />
            </div>
          )}
        </div>
        <Segmented
          value={days}
          onChange={setDays}
          label={t("dashboard.activity.title")}
          options={RANGES.map((range) => ({
            value: range,
            label: t("dashboard.activity.range", { count: range }),
          }))}
        />
      </div>

      {activity.isLoading ? (
        <Skeleton className="h-56 w-full" />
      ) : total === 0 ? (
        <div className="flex h-56 items-center justify-center rounded-[10px] bg-panel-inset/60 text-sm text-muted-foreground dark:bg-neutral-900">
          {t("dashboard.activity.empty")}
        </div>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-56 w-full">
          <BarChart
            accessibilityLayer
            data={buckets}
            margin={{ top: 8, right: 0, left: 0, bottom: 0 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickFormatter={formatDay}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={28}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    payload[0]?.payload?.date
                      ? formatDay(String(payload[0].payload.date))
                      : ""
                  }
                />
              }
            />
            <Bar
              dataKey="succeeded"
              stackId="builds"
              fill="var(--color-succeeded)"
              isAnimationActive={false}
            />
            <Bar
              dataKey="failed"
              stackId="builds"
              fill="var(--color-failed)"
              isAnimationActive={false}
            />
            <Bar
              dataKey="other"
              stackId="builds"
              fill="var(--color-other)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ChartContainer>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Applications showcase
// ---------------------------------------------------------------------------

const APPS_PER_PAGE = 4

export function AppsShowcaseCard({
  apps,
  orgSlug,
  loading,
}: {
  apps: ReadonlyArray<AppListItem & { runtimeStatus: AppStatus }>
  orgSlug: string
  loading: boolean
}) {
  const { t } = useTranslation("workspace")
  const [page, setPage] = React.useState(0)
  const pages = Math.max(1, Math.ceil(apps.length / APPS_PER_PAGE))
  const current = Math.min(page, pages - 1)
  const visible = [...apps]
    .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt))
    .slice(current * APPS_PER_PAGE, (current + 1) * APPS_PER_PAGE)

  return (
    <section className={cn(CARD, "gap-3")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <CardLabel>{t("dashboard.applications")}</CardLabel>
          {loading ? (
            <Skeleton className="mt-1 h-7 w-10" />
          ) : (
            <BigNumber>{apps.length}</BigNumber>
          )}
        </div>
        <Link
          to={organizationPath(orgSlug, "apps") as never}
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          {t("dashboard.viewAll")}
          <RiArrowRightLine className="size-4" />
        </Link>
      </div>

      {loading ? (
        <div className="grid flex-1 gap-2 sm:grid-cols-2">
          {Array.from({ length: APPS_PER_PAGE }).map((_, index) => (
            <Skeleton key={index} className="h-[92px] w-full rounded-[10px]" />
          ))}
        </div>
      ) : apps.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-[10px] bg-panel-inset/60 py-10 text-sm text-muted-foreground dark:bg-neutral-900">
          {t("dashboard.noAppsYet")}
        </div>
      ) : (
        <ul className="grid flex-1 content-start gap-2 sm:grid-cols-2">
          {visible.map((app) => (
            <li key={app.id}>
              <Link
                to={organizationPath(orgSlug, `apps/${app.id}/settings`) as never}
                className="flex h-full min-w-0 flex-col justify-between gap-2.5 rounded-[10px] bg-panel-inset p-2.5 shadow-[0_1px_1px_0_#0000000d] transition-colors outline-none hover:bg-panel-inset/70 focus-visible:ring-2 focus-visible:ring-ring dark:shadow-[0_1px_1px_0_#00000024]"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <AppIcon
                    name={app.name}
                    src={app.iconUrl}
                    className="size-9 shrink-0"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {app.name}
                    </span>
                    <span className="truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
                      {t("dashboard.updated", {
                        time: relativeTime(app.updatedAt),
                      })}
                    </span>
                  </span>
                </span>
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-panel px-1.5 py-1 text-xs font-medium text-muted-foreground dark:bg-neutral-800">
                    <RiGitBranchLine className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {app.branch ?? app.imageRef ?? "–"}
                    </span>
                  </span>
                  <AppStatusBadge status={app.runtimeStatus} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.max(0, current - 1))}
            disabled={current === 0}
          >
            <RiArrowLeftSLine />
            {t("common:previous")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.min(pages - 1, current + 1))}
            disabled={current >= pages - 1}
          >
            {t("common:next")}
            <RiArrowRightSLine />
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function toMs(value: number | string | undefined): number {
  const ms = typeof value === "string" ? Date.parse(value) : value
  return ms !== undefined && Number.isFinite(ms) ? ms : 0
}

function relativeTime(value: number | string | undefined): string {
  const ms = typeof value === "string" ? Date.parse(value) : value
  if (ms === undefined || !Number.isFinite(ms)) return "–"
  const formatter = new Intl.RelativeTimeFormat(i18n.resolvedLanguage, {
    numeric: "auto",
  })
  const seconds = Math.round((ms - Date.now()) / 1000)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ]
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit)
    }
  }
  return formatter.format(seconds, "second")
}

// ---------------------------------------------------------------------------
// Host resources (instance admins only: the API answers 403 otherwise)
// ---------------------------------------------------------------------------

function Gauge({
  label,
  percent,
  hint,
  warnAt,
  note,
  title,
}: {
  label: string
  percent: number
  hint: string
  warnAt: number
  note?: string
  title?: string
}) {
  const radius = 34
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(100, Math.max(0, percent))
  const tone =
    clamped >= 90
      ? "stroke-neg-600"
      : clamped >= warnAt
        ? "stroke-warn-600"
        : "stroke-viz-400"
  return (
    <div
      title={title}
      className="flex min-w-0 flex-col items-center gap-2 rounded-[10px] bg-panel-inset p-3 shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]"
    >
      <div className="relative size-24">
        <svg viewBox="0 0 80 80" className="size-full -rotate-90">
          <circle
            cx="40"
            cy="40"
            r={radius}
            className="fill-none stroke-[#ebebeb] dark:stroke-neutral-800"
            strokeWidth="8"
          />
          <circle
            cx="40"
            cy="40"
            r={radius}
            className={cn(
              "fill-none transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none",
              tone
            )}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped / 100)}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-lg font-medium text-foreground tabular-nums">
          {Math.round(clamped)}%
        </span>
      </div>
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
        {hint}
      </span>
      {note ? (
        <span
          title={title}
          className="w-full text-center text-[11px] leading-4 font-normal text-muted-foreground"
        >
          {note}
        </span>
      ) : null}
    </div>
  )
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function HostResourcesCard() {
  const { t } = useTranslation("workspace")
  const { data, isLoading } = useHostStats()
  const reclaimed = data?.mem_reclaimed_bytes ?? 0
  const balloonNote =
    data && reclaimed > 0
      ? t("dashboard.host.usableOfConfigured", {
          total: gib(data.mem_total_bytes),
          configured: gib(data.mem_configured_bytes ?? 0),
        })
      : undefined
  const balloonTitle =
    data && reclaimed > 0
      ? t("dashboard.host.reclaimedBalloon", {
          reclaimed: gib(reclaimed),
        })
      : undefined

  return (
    <section className={cn(CARD, "gap-3")}>
      <CardLabel>{t("dashboard.host.title")}</CardLabel>
      {isLoading || !data ? (
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-44 w-full rounded-[10px]" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <Gauge
            label={t("dashboard.host.cpu")}
            percent={data.cpu_percent}
            hint={t("dashboard.host.cores", { count: data.cpu_count })}
            warnAt={70}
          />
          <Gauge
            label={t("dashboard.host.memory")}
            percent={
              data.mem_total_bytes > 0
                ? (data.mem_used_bytes / data.mem_total_bytes) * 100
                : 0
            }
            hint={`${gib(data.mem_used_bytes)} / ${gib(data.mem_total_bytes)}`}
            note={balloonNote}
            title={balloonTitle}
            warnAt={data.thresholds.mem_warn_pct}
          />
          <Gauge
            label={t("dashboard.host.disk")}
            percent={
              data.disk_total_bytes > 0
                ? (data.disk_used_bytes / data.disk_total_bytes) * 100
                : 0
            }
            hint={`${gib(data.disk_used_bytes)} / ${gib(data.disk_total_bytes)}`}
            warnAt={data.thresholds.disk_warn_pct}
          />
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Latest deployments table
// ---------------------------------------------------------------------------

const RECENT_FILTERS = { page: 1, pageSize: 5 } as const

export function RecentDeploymentsCard({
  orgSlug,
  appIds,
  onOpenBuild,
}: {
  orgSlug: string
  appIds: ReadonlyArray<string> | undefined
  onOpenBuild: (buildId: string, appId: string) => void
}) {
  const { t } = useTranslation("workspace")
  const query = useWorkspaceDeployments(orgSlug, RECENT_FILTERS, appIds)
  const actions = useWorkspaceDeploymentActions(orgSlug)
  const deployments = query.data?.deployments ?? []
  const total = query.data?.pagination.total ?? 0

  const runAction = (
    mutation: typeof actions.rollback | typeof actions.cancel,
    build: Build
  ) => {
    const deployment = deployments.find((item) => item.id === build.id)
    if (!deployment) return
    mutation.mutate({ appId: deployment.app.id, buildId: deployment.id })
  }

  return (
    <section className="flex w-full flex-col rounded-2xl border border-[#ebebeb] pt-2 pb-3 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-3 px-3 py-1">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-sm font-medium text-neutral-400 dark:text-neutral-500">
            {t("dashboard.recent.title")}
          </h2>
          <p className="text-sm font-medium text-foreground">
            {t("dashboard.recent.count", { count: total })}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to={organizationPath(orgSlug, "deployments") as never}>
            {t("dashboard.viewAll")}
            <RiArrowRightLine />
          </Link>
        </Button>
      </div>
      <div className="mt-3">
        <DeploymentsTable
          builds={deployments}
          isLoading={query.isLoading}
          onSelectBuild={(buildId) => {
            const deployment = deployments.find((item) => item.id === buildId)
            if (deployment) onOpenBuild(buildId, deployment.app.id)
          }}
          onRollback={(build) => runAction(actions.rollback, build)}
          onCancel={(build) => runAction(actions.cancel, build)}
          showApplication
          appDeploymentsHref={(app) =>
            organizationPath(orgSlug, `apps/${app.id}/deployments`)
          }
          canManage={query.data?.canManage ?? false}
          paginate={false}
          flush
        />
      </div>
    </section>
  )
}
