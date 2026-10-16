// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  RiCpuLine,
  RiHardDriveLine,
  RiPulseLine,
  RiServerLine,
} from "@remixicon/react"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import { useHostStats } from "../../lib/host-stats"
import type { HostStats } from "../../lib/host-stats"

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(0)} MB`
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(1)} GB`
  return `${(b / 1024 ** 4).toFixed(2)} TB`
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86_400)
  const h = Math.floor((secs % 86_400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const PCT_WARN = 70
const PCT_CRIT = 90

function pctClass(pct: number): string {
  if (pct >= PCT_CRIT) return "text-destructive"
  if (pct >= PCT_WARN) return "text-amber-600 dark:text-amber-400"
  return "text-foreground"
}

function fillClass(pct: number): string {
  if (pct >= PCT_CRIT) return "bg-destructive"
  if (pct >= PCT_WARN) return "bg-amber-500"
  return "bg-emerald-500"
}

export function HostHealthCard(): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const { data, isLoading, error } = useHostStats()

  if (isLoading) {
    return (
      <div className="rounded-2xl bg-panel p-4">
        <div className="h-4 w-32 rounded skeleton-surface" />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded skeleton-surface" />
          ))}
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
        <p className="font-sans text-xs text-amber-600 dark:text-amber-400">
          host_stats_unavailable
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {error?.message ?? t("host.unavailable")}
        </p>
      </div>
    )
  }

  return <HostHealthBody data={data} />
}

function HostHealthBody({ data }: { data: HostStats }): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const memPct =
    data.mem_total_bytes > 0
      ? (data.mem_used_bytes / data.mem_total_bytes) * 100
      : 0
  const diskPct =
    data.disk_total_bytes > 0
      ? (data.disk_used_bytes / data.disk_total_bytes) * 100
      : 0
  const loadPerCpu =
    data.cpu_count > 0 ? data.load_1 / data.cpu_count : data.load_1
  const inodesPct =
    data.inodes_total > 0 ? (data.inodes_used / data.inodes_total) * 100 : 0

  const thresholds = data.thresholds
  const hasAlerts = data.alerts.length > 0

  return (
    <section
      aria-label={t("host.section")}
      className="rounded-2xl bg-panel"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="space-y-0.5">
          <p className="font-sans text-xs text-muted-foreground">
            {t("host.vps")}
          </p>
          <p className="text-sm font-medium">
            {t("host.serverHealth")}{" "}
            <span className="ml-1 font-sans text-xs text-muted-foreground">
              {t("host.uptime", { value: formatUptime(data.uptime_seconds) })}
            </span>
          </p>
        </div>
        {hasAlerts ? (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-neg-100 dark:bg-[#4d0218]/60 px-2 text-xs font-medium text-neg-700 dark:text-[#ff637e]">
            <span className="size-1.5 rounded-full bg-destructive" />
            {t("host.alerts", { count: data.alerts.length })}
          </span>
        ) : (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-pos-100 dark:bg-[#192e03]/60 px-2 text-xs font-medium text-pos-700 dark:text-[#9ae600]">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {t("healthy")}
          </span>
        )}
      </header>

      <dl className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
        <Cell
          icon={RiCpuLine}
          label={t("host.cpu")}
          value={`${data.cpu_percent.toFixed(1)}%`}
          sub={t("cores", { count: data.cpu_count })}
          fill={data.cpu_percent}
          fillClassName={fillClass(data.cpu_percent)}
        />
        <Cell
          icon={RiServerLine}
          label={t("host.memory")}
          value={`${memPct.toFixed(0)}%`}
          sub={`${formatBytes(data.mem_used_bytes)} / ${formatBytes(data.mem_total_bytes)}`}
          accent={pctClass(memPct)}
          fill={memPct}
          fillClassName={fillClass(memPct)}
        />
        <Cell
          icon={RiHardDriveLine}
          label={t("host.diskRoot")}
          value={`${diskPct.toFixed(0)}%`}
          sub={`${formatBytes(data.disk_used_bytes)} / ${formatBytes(data.disk_total_bytes)} · ${t("host.inodes", { pct: inodesPct.toFixed(0) })}`}
          accent={pctClass(diskPct)}
          fill={diskPct}
          fillClassName={fillClass(diskPct)}
        />
        <Cell
          icon={RiPulseLine}
          label={t("host.loadAvg")}
          value={data.load_1.toFixed(2)}
          sub={`5m ${data.load_5.toFixed(2)} · 15m ${data.load_15.toFixed(2)} · ${loadPerCpu.toFixed(2)}/cpu`}
          accent={
            loadPerCpu > thresholds.load_warn_per_cpu
              ? "text-destructive"
              : loadPerCpu > thresholds.load_warn_per_cpu * 0.66
                ? "text-amber-600 dark:text-amber-400"
                : undefined
          }
          fill={
            thresholds.load_warn_per_cpu > 0
              ? (loadPerCpu / thresholds.load_warn_per_cpu) * 100
              : 0
          }
          fillClassName={
            loadPerCpu > thresholds.load_warn_per_cpu
              ? "bg-destructive"
              : loadPerCpu > thresholds.load_warn_per_cpu * 0.66
                ? "bg-amber-500"
                : "bg-emerald-500"
          }
        />
        {data.gpu_count > 0 ? (
          <Cell
            icon={RiCpuLine}
            label={t("host.gpu")}
            value={`${data.gpu_utilization_pct.toFixed(0)}%`}
            sub={`${formatBytes(data.gpu_mem_used_bytes)} / ${formatBytes(data.gpu_mem_total_bytes)}${data.gpu_name ? ` · ${data.gpu_name}` : ""}${data.gpu_count > 1 ? ` · ${data.gpu_count} GPUs` : ""}`}
            fill={data.gpu_utilization_pct}
            fillClassName={fillClass(data.gpu_utilization_pct)}
          />
        ) : null}
      </dl>

      {hasAlerts ? (
        <div className="border-t border-border bg-destructive/5 px-4 py-2 font-sans text-[11px] text-destructive">
          {data.alerts.join(" · ")}
        </div>
      ) : null}

      {data.error ? (
        <div className="border-t border-border bg-amber-500/5 px-4 py-2 font-sans text-[10px] text-amber-600 dark:text-amber-400">
          {t("host.partial", { error: data.error })}
        </div>
      ) : null}
    </section>
  )
}

function Cell({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  fill,
  fillClassName,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
  accent?: string
  fill?: number
  fillClassName?: string
}): React.JSX.Element {
  const clamped =
    fill === undefined ? undefined : Math.min(100, Math.max(0, fill))
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <dt className="flex items-center gap-1.5 font-sans text-xs text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </dt>
      <dd className={cn("text-xl font-medium tabular-nums", accent)}>
        {value}
      </dd>
      {sub ? (
        <p className="font-sans text-[10px] text-muted-foreground">{sub}</p>
      ) : null}
      {clamped !== undefined ? (
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
              fillClassName
            )}
            style={{ width: `${clamped}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}
