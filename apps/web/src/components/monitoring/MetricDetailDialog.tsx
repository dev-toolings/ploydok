// SPDX-License-Identifier: AGPL-3.0-only
//
// MetricDetailDialog — panneau de télémétrie plein pour un container, avec
// chart Recharts, stats hero (current/min/avg/max), threshold-aware accent,
// live indicator SSE, et progress bar pour la mémoire.

import * as React from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"
import {
  RiArrowDownLine,
  RiArrowRightLine,
  RiArrowUpLine,
  RiCpuLine,
  RiDatabase2Line,
  RiPulseLine,
  RiRestartLine,
  RiTimeLine,
} from "@remixicon/react"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@workspace/ui/components/chart"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import i18n from "../../lib/i18n"
import type { ChartConfig } from "@workspace/ui/components/chart"

import type { ContainerSnapshot } from "@ploydok/shared"

interface MetricDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  metric: "cpu" | "mem"
  snapshot: ContainerSnapshot
  /** Points en unité native: % pour CPU, MB pour mem. */
  points: Array<number>
  stepSeconds?: number
}

type Severity = "ok" | "warn" | "danger"

const METRIC_STYLES = {
  cpu: {
    icon: RiCpuLine,
    titleKey: "cpuUsage",
    unit: " %",
    decimals: 2,
    color: "#3b82f6",
    accentText: "text-blue-700 dark:text-blue-400",
    accentBg: "bg-blue-500/10",
    accentRail: "bg-blue-500",
    accentRing: "ring-blue-500/30",
    gradientId: "fill-cpu-detail",
  },
  mem: {
    icon: RiDatabase2Line,
    titleKey: "memoryUsage",
    unit: " MB",
    decimals: 1,
    color: "#8b5cf6",
    accentText: "text-violet-700 dark:text-violet-400",
    accentBg: "bg-violet-500/10",
    accentRail: "bg-violet-500",
    accentRing: "ring-violet-500/30",
    gradientId: "fill-mem-detail",
  },
} as const

const SEVERITY_TEXT: Record<Severity, string> = {
  ok: "",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
}
const SEVERITY_BAR: Record<Severity, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  danger: "bg-red-500",
}

export function MetricDetailDialog({
  open,
  onOpenChange,
  metric,
  snapshot,
  points,
  stepSeconds = 5,
}: MetricDetailDialogProps): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const style = METRIC_STYLES[metric]
  const Icon = style.icon
  const title = t(style.titleKey)

  // Memory limit in MB for severity computation + progress bar.
  const memLimitMB = snapshot.mem_limit_bytes
    ? snapshot.mem_limit_bytes / (1024 * 1024)
    : 0

  const { current, min, max, avg, trimmed, data } = React.useMemo(() => {
    const t = points.slice(-60)
    if (t.length === 0) {
      return { current: 0, min: 0, max: 0, avg: 0, trimmed: t, data: [] }
    }
    const last = t[t.length - 1] ?? 0
    const m = Math.max(...t)
    const lo = Math.min(...t)
    const a = t.reduce((acc, v) => acc + v, 0) / t.length
    const n = t.length
    const d = t.map((v, i) => ({
      t: -(n - 1 - i) * stepSeconds,
      value: v,
    }))
    return { current: last, min: lo, max: m, avg: a, trimmed: t, data: d }
  }, [points, stepSeconds])

  const formatValue = React.useCallback(
    (v: number): string => `${v.toFixed(style.decimals)}${style.unit}`,
    [style.decimals, style.unit]
  )

  const severity: Severity = React.useMemo(() => {
    if (metric === "cpu") {
      if (current >= 80) return "danger"
      if (current >= 50) return "warn"
      return "ok"
    }
    if (memLimitMB <= 0) return "ok"
    const ratio = current / memLimitMB
    if (ratio >= 0.9) return "danger"
    if (ratio >= 0.7) return "warn"
    return "ok"
  }, [metric, current, memLimitMB])

  const memUsagePercent =
    metric === "mem" && memLimitMB > 0
      ? Math.min(100, (current / memLimitMB) * 100)
      : null

  // Trend: current vs average. Only meaningful with ≥ 2 points.
  const trend = React.useMemo(() => {
    if (trimmed.length < 2) return null
    const delta = current - avg
    const epsilon = metric === "cpu" ? 0.5 : 1 // ignore noise
    if (Math.abs(delta) < epsilon) return { dir: "flat" as const, delta }
    return { dir: delta > 0 ? ("up" as const) : ("down" as const), delta }
  }, [trimmed.length, current, avg, metric])

  const chartConfig: ChartConfig = {
    value: {
      label: title,
      color: style.color,
    },
  }

  // Live freshness — pulsing dot in header.
  const liveness = React.useMemo(() => {
    const ageSec = snapshot.last_seen_ms
      ? Math.max(0, Math.floor((Date.now() - snapshot.last_seen_ms) / 1000))
      : Infinity
    if (ageSec <= 10) return { tone: "ok" as const, label: "live", ageSec }
    if (ageSec <= 30) return { tone: "warn" as const, label: "stale", ageSec }
    return { tone: "down" as const, label: "offline", ageSec }
  }, [snapshot.last_seen_ms])

  const empty = trimmed.length < 2

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden border-border/60 p-0 shadow-2xl backdrop-blur-sm sm:max-w-2xl">
        {/* Rail vertical coloré gauche — anchor visuel du metric */}
        <span
          aria-hidden
          className={cn("absolute inset-y-0 left-0 w-[3px]", style.accentRail)}
        />

        <div className="px-6 pt-6 pb-5">
          {/* Header — metric tag + container name + live pill */}
          <DialogHeader className="space-y-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Icon className={cn("size-3.5", style.accentText)} />
                <span className="text-xs font-semibold">
                  {title}
                </span>
              </div>
              <LivePill tone={liveness.tone} ageSec={liveness.ageSec} />
            </div>
            <DialogTitle className="font-heading text-xl leading-tight">
              {snapshot.name}
            </DialogTitle>
            <DialogDescription className="font-sans text-xs tabular-nums">
              {snapshot.image}
              {snapshot.kind ? (
                <>
                  <span className="mx-1.5 text-muted-foreground/50">·</span>
                  <span className="">
                    {snapshot.kind}
                  </span>
                </>
              ) : null}
              <span className="mx-1.5 text-muted-foreground/50">·</span>
              <span className="">
                {snapshot.status}
              </span>
            </DialogDescription>
          </DialogHeader>

          {/* Hero stats: Current dominant + trend, then Min/Avg/Max */}
          <div className="mt-6 grid gap-3 sm:grid-cols-[1.25fr_1fr_1fr_1fr]">
            <HeroStatCurrent
              label={t("current")}
              value={formatValue(current)}
              valueClass={cn(
                "font-sans text-[28px] leading-none font-semibold tabular-nums",
                severity === "ok" ? style.accentText : SEVERITY_TEXT[severity]
              )}
              trend={trend}
              formatDelta={(d) =>
                `${d > 0 ? "+" : ""}${d.toFixed(style.decimals)}${style.unit}`
              }
              accentRing={style.accentRing}
            />
            <HeroStat
              label={t("min")}
              value={formatValue(min)}
              valueClass="font-sans text-[16px] font-semibold leading-none tabular-nums text-foreground"
            />
            <HeroStat
              label={t("avg")}
              value={formatValue(avg)}
              valueClass="font-sans text-[16px] font-semibold leading-none tabular-nums text-foreground"
            />
            <HeroStat
              label={t("max")}
              value={formatValue(max)}
              valueClass="font-sans text-[16px] font-semibold leading-none tabular-nums text-foreground"
            />
          </div>

          {/* Memory: progress bar of limit */}
          {metric === "mem" && memUsagePercent !== null ? (
            <div className="mt-4 rounded-md border border-border bg-muted/30 px-3.5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-semibold text-muted-foreground">
                  {t("limitUsage")}
                </span>
                <span className="font-sans text-[12px] text-foreground tabular-nums">
                  {memUsagePercent.toFixed(1)}%
                  <span className="ml-1 text-muted-foreground">
                    {t("ofLimit", {
                      limit: formatBytes(snapshot.mem_limit_bytes),
                    })}
                  </span>
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/70">
                <div
                  className={cn(
                    "h-full transition-[width] duration-500",
                    SEVERITY_BAR[severity]
                  )}
                  style={{
                    width: `${Math.max(memUsagePercent, 1.5)}%`,
                  }}
                />
              </div>
            </div>
          ) : null}

          {/* Chart */}
          <div className="mt-6">
            {empty ? (
              <EmptyChart height={260} />
            ) : (
              <ChartContainer
                config={chartConfig}
                className="aspect-auto h-[260px] w-full"
              >
                <AreaChart
                  accessibilityLayer
                  data={data}
                  margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient
                      id={style.gradientId}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor={style.color}
                        stopOpacity={0.45}
                      />
                      <stop
                        offset="95%"
                        stopColor={style.color}
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    vertical={false}
                    strokeDasharray="3 3"
                    stroke="currentColor"
                    opacity={0.18}
                  />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={["dataMin", 0]}
                    ticks={computeXTicks(trimmed.length, stepSeconds)}
                    tickFormatter={formatXTick}
                    axisLine={false}
                    tickLine={false}
                    tick={{
                      fontFamily: "var(--font-sans)",
                      fontSize: 10,
                      fill: "rgba(100, 116, 139, 0.8)",
                    }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    domain={[0, "auto"]}
                    tickFormatter={(v: number) =>
                      v.toFixed(style.decimals === 1 ? 0 : 1)
                    }
                    axisLine={false}
                    tickLine={false}
                    width={40}
                    tick={{
                      fontFamily: "var(--font-sans)",
                      fontSize: 10,
                      fill: "rgba(100, 116, 139, 0.8)",
                    }}
                  />
                  <ReferenceLine
                    y={avg}
                    stroke={style.color}
                    strokeDasharray="4 4"
                    strokeOpacity={0.5}
                    label={{
                      value: "avg",
                      position: "insideRight",
                      fill: style.color,
                      fontSize: 9,
                      fontFamily: "var(--font-sans)",
                    }}
                  />
                  <ChartTooltip
                    cursor={{
                      stroke: style.color,
                      strokeWidth: 1,
                      strokeDasharray: "3 3",
                      strokeOpacity: 0.6,
                    }}
                    content={
                      <ChartTooltipContent
                        indicator="line"
                        labelFormatter={(_l, items) => {
                          const t = items[0]?.payload?.t as number | undefined
                          if (typeof t !== "number") return ""
                          if (t === 0) return i18n.t("monitoring:now")
                          const s = Math.abs(t)
                          if (s < 60)
                            return i18n.t("monitoring:secondsAgoChart", {
                              count: s,
                            })
                          const m = Math.round(s / 60)
                          return i18n.t("monitoring:minutesAgoChart", {
                            count: m,
                          })
                        }}
                        formatter={(value) => {
                          const num =
                            typeof value === "number" ? value : Number(value)
                          return formatValue(num)
                        }}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={style.color}
                    strokeWidth={2}
                    fill={`url(#${style.gradientId})`}
                    isAnimationActive
                    animationDuration={700}
                    animationEasing="ease-out"
                  />
                  {/* Dot pulsé sur le dernier point — anchor "now" */}
                  <ReferenceDot
                    x={0}
                    y={current}
                    r={4}
                    fill={style.color}
                    stroke="white"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </div>

          {/* Footer — container metadata + ESC hint */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/60 pt-3 font-sans text-xs text-muted-foreground/80 tabular-nums">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <FooterStat
                icon={<RiTimeLine className="size-3" />}
                label={t("up")}
                value={formatUptime(snapshot.uptime_s)}
              />
              <FooterStat
                icon={<RiRestartLine className="size-3" />}
                label={t("restarts")}
                value={String(snapshot.restart_count)}
                emphasize={snapshot.restart_count > 0}
              />
              <FooterStat
                icon={<RiPulseLine className="size-3" />}
                label={t("samples")}
                value={`${trimmed.length}/60`}
              />
              <FooterStat
                label={t("interval")}
                value={`${stepSeconds}s`}
              />
            </div>
            <kbd className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-xs font-medium tracking-normal text-muted-foreground/80 normal-case">
              ESC
            </kbd>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Sous-composants locaux
// ---------------------------------------------------------------------------

function HeroStatCurrent({
  label,
  value,
  valueClass,
  trend,
  formatDelta,
  accentRing,
}: {
  label: string
  value: string
  valueClass: string
  trend: { dir: "up" | "down" | "flat"; delta: number } | null
  formatDelta: (d: number) => string
  accentRing: string
}): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const TrendIcon =
    trend?.dir === "up"
      ? RiArrowUpLine
      : trend?.dir === "down"
        ? RiArrowDownLine
        : trend?.dir === "flat"
          ? RiArrowRightLine
          : null
  const trendColor =
    trend?.dir === "up"
      ? "text-amber-600 dark:text-amber-400"
      : trend?.dir === "down"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-muted-foreground"

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-3.5 py-3 ring-1 ring-transparent transition-shadow ring-inset",
        accentRing && "hover:ring-current"
      )}
    >
      <span className="text-xs font-semibold text-muted-foreground">
        {label}
      </span>
      <div className="flex items-baseline gap-2">
        <span className={valueClass}>{value}</span>
        {trend && TrendIcon ? (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 font-sans text-xs font-medium tabular-nums",
              trendColor
            )}
            title={
              trend.dir === "flat"
                ? t("stable")
                : trend.dir === "up"
                  ? t("aboveAverage")
                  : t("belowAverage")
            }
          >
            <TrendIcon className="size-3" />
            {trend.dir !== "flat" ? formatDelta(trend.delta) : t("stable")}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function HeroStat({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 px-3.5 py-3">
      <span className="text-xs font-semibold text-muted-foreground">
        {label}
      </span>
      <span className={valueClass}>{value}</span>
    </div>
  )
}

function FooterStat({
  icon,
  label,
  value,
  emphasize,
}: {
  icon?: React.ReactNode
  label: string
  value: string
  emphasize?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="text-muted-foreground/60">{label}</span>
      <span
        className={cn(
          "text-foreground",
          emphasize && "text-amber-600 dark:text-amber-400"
        )}
      >
        {value}
      </span>
    </div>
  )
}

function LivePill({
  tone,
  ageSec,
}: {
  tone: "ok" | "warn" | "down"
  ageSec: number
}): React.JSX.Element {
  const dotColor =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-500"
        : "bg-red-500"
  const textColor =
    tone === "ok"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : "text-red-600 dark:text-red-400"
  const { t } = useTranslation("monitoring")
  const label =
    tone === "ok"
      ? t("liveLabel")
      : tone === "warn"
        ? t("secondsAgoShort", { count: ageSec })
        : t("offlineLabel")

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-border/70 bg-background/80 px-2 py-0.5 font-sans text-xs",
        textColor
      )}
      title={t("lastSeen", { count: ageSec })}
    >
      <span className="relative flex size-1.5">
        {tone === "ok" ? (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
              dotColor
            )}
          />
        ) : null}
        <span
          className={cn("relative inline-flex size-1.5 rounded-full", dotColor)}
        />
      </span>
      {label}
    </span>
  )
}

function EmptyChart({ height }: { height: number }): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  return (
    <div
      className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-panel-border bg-panel-inset text-muted-foreground"
      style={{ height }}
    >
      <RiPulseLine className="size-5 opacity-50" />
      <span className="text-xs">{t("collecting")}</span>
      <span className="text-[10px] text-muted-foreground/70">
        {t("collectingHint")}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeXTicks(n: number, step: number): Array<number> {
  if (n < 2) return [0]
  const minT = -(n - 1) * step
  // 5 ticks evenly spaced including endpoints.
  const ticks: Array<number> = []
  for (let i = 0; i < 5; i++) {
    ticks.push(Math.round((minT * (4 - i)) / 4))
  }
  return ticks
}

function formatXTick(v: number): string {
  if (v === 0) return i18n.t("monitoring:now")
  const s = Math.abs(v)
  if (s < 60) return `-${s}s`
  const m = Math.round(s / 60)
  return `-${m}m`
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB"
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(0)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`
}
