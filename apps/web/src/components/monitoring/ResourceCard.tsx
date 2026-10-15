// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Button } from "@workspace/ui/components/button"

import { healthClass, memRatio } from "@ploydok/shared"
import {
  RiBox3Line,
  RiCpuLine,
  RiHistoryLine,
  RiPulseLine,
  RiRestartLine,
  RiServerLine,
  RiSettings3Line,
  RiWifiLine,
} from "@remixicon/react"

import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import { MetricCardButton } from "./MetricCardButton"
import { MetricDetailDialog } from "./MetricDetailDialog"
import type { ContainerSnapshot } from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h < 24) return rem > 0 ? `${h}h ${rem}m` : `${h}h`
  const d = Math.floor(h / 24)
  const remH = h % 24
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// ---------------------------------------------------------------------------
// Kind badge — small coloured pill at card corner
// ---------------------------------------------------------------------------

function KindBadge({
  kind,
}: {
  kind: ContainerSnapshot["kind"]
}): React.JSX.Element {
  const k = kind ?? "unknown"
  const style = {
    app: {
      icon: RiBox3Line,
      label: "APP",
      cls: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff] border-sky-500/20",
    },
    infra: {
      icon: RiServerLine,
      label: "INFRA",
      cls: "bg-violet-100 dark:bg-[#2f0d68]/60 text-violet-700 dark:text-[#a684ff] border-violet-500/20",
    },
    database: {
      icon: RiServerLine,
      label: "DB",
      cls: "bg-cyan-500/10 text-cyan-700 border-cyan-500/20 dark:text-cyan-300",
    },
    agent: {
      icon: RiSettings3Line,
      label: "AGENT",
      cls: "bg-warn-100 dark:bg-[#432004]/60 text-warn-700 dark:text-[#fdc700] border-amber-500/20",
    },
    unknown: {
      icon: RiBox3Line,
      label: "UNKNOWN",
      cls: "bg-muted text-muted-foreground border-border",
    },
  }[k]
  const Icon = style.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-sans text-[9px] tracking-wide",
        style.cls
      )}
    >
      <Icon className="size-3" />
      {style.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Status chip (replaces StatusDot+label combo)
// ---------------------------------------------------------------------------

function StatusChip({
  snapshot,
}: {
  snapshot: ContainerSnapshot
}): React.JSX.Element {
  const cls = healthClass(snapshot)
  const tone = {
    healthy: {
      dot: "bg-emerald-500",
      ring: "bg-emerald-500/60",
      text: "text-emerald-700 dark:text-emerald-300",
      bg: "bg-emerald-500/10",
      animate: true,
    },
    warn: {
      dot: "bg-amber-500",
      ring: "bg-amber-500/60",
      text: "text-amber-700 dark:text-amber-300",
      bg: "bg-amber-500/10",
      animate: false,
    },
    down: {
      dot: "bg-destructive",
      ring: "bg-destructive/60",
      text: "text-destructive",
      bg: "bg-destructive/10",
      animate: false,
    },
  }[cls]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium capitalize",
        tone.bg,
        tone.text
      )}
    >
      <span className="relative flex size-1.5">
        {tone.animate ? (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full",
              tone.ring
            )}
          />
        ) : null}
        <span
          className={cn("relative inline-flex size-1.5 rounded-full", tone.dot)}
        />
      </span>
      {snapshot.status}
    </span>
  )
}

// ---------------------------------------------------------------------------
// ResourceCard
// ---------------------------------------------------------------------------

interface ResourceCardProps {
  snapshot: ContainerSnapshot
  cpuHistory: Array<number>
  memHistory: Array<number>
  onPing?: () => void
  pinging?: boolean
}

export function ResourceCard({
  snapshot,
  cpuHistory,
  memHistory,
  onPing,
  pinging = false,
}: ResourceCardProps) {
  const { t } = useTranslation("monitoring")
  const ratio = memRatio(snapshot)
  const ratioPercent = Math.round(ratio * 100)

  const memHistoryMB = React.useMemo(
    () => memHistory.map((v) => v / 1_048_576),
    [memHistory]
  )

  const [openMetric, setOpenMetric] = React.useState<null | "cpu" | "mem">(
    null
  )

  const cpuLast = cpuHistory.at(-1) ?? 0
  const memLastMB = memHistoryMB.at(-1) ?? 0

  const barColor =
    ratio > 0.85
      ? "bg-destructive"
      : ratio > 0.65
        ? "bg-amber-500"
        : "bg-emerald-500"

  return (
    <div
      className={cn(
        "group/card relative flex flex-col gap-3 overflow-hidden rounded-2xl bg-panel p-4",
        "transition-colors hover:border-border/80"
      )}
    >
      {/* Header */}
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <KindBadge kind={snapshot.kind} />
            <StatusChip snapshot={snapshot} />
          </div>
          <p
            className="truncate text-sm font-semibold text-foreground"
            title={snapshot.name}
          >
            {snapshot.name}
          </p>
          <p
            className="truncate font-mono text-[10px] text-muted-foreground"
            title={snapshot.image}
          >
            {snapshot.image}
          </p>
        </div>

        {onPing ? (
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={onPing}
            loading={pinging}
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
            aria-label={t("pingContainer")}
            title={t("pingTitle")}
          >
            <RiWifiLine className="size-3.5" />
          </Button>
        ) : null}
      </header>

      {/* Metrics — CPU + MEM sparklines side by side */}
      <div className="grid grid-cols-2 gap-2">
        <MetricCardButton
          metric="cpu"
          value={`${cpuLast.toFixed(2)} %`}
          history={cpuHistory}
          unit=" %"
          onClick={() => setOpenMetric("cpu")}
        />
        <MetricCardButton
          metric="mem"
          value={`${memLastMB.toFixed(1)} MB`}
          history={memHistoryMB}
          unit=" MB"
          onClick={() => setOpenMetric("mem")}
        />
      </div>

      {/* Memory usage meter */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between font-sans text-xs text-muted-foreground">
          <span className="">{t("memoryBudget")}</span>
          <span className="tabular-nums">
            <span className="text-foreground">{formatBytes(snapshot.mem_bytes)}</span>
            <span className="opacity-50"> / </span>
            <span>{formatBytes(snapshot.mem_limit_bytes)}</span>
            <span className="ml-1.5 opacity-50">{ratioPercent}%</span>
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all", barColor)}
            style={{ width: `${Math.max(ratioPercent, 1.5)}%` }}
          />
        </div>
      </div>

      {/* Footer metadata — small row */}
      <footer className="flex items-center justify-between gap-2 border-t border-border pt-3 font-sans text-[10px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <FootStat icon={RiHistoryLine} label={t("up")} value={formatUptime(snapshot.uptime_s)} />
          <FootStat
            icon={RiRestartLine}
            label={t("restarts")}
            value={String(snapshot.restart_count)}
            alert={snapshot.restart_count > 0}
          />
          <FootStat
            icon={RiCpuLine}
            label={t("avg")}
            value={`${snapshot.cpu_pct.toFixed(1)}%`}
          />
        </div>
        {snapshot.last_ping_ms !== undefined ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5",
              snapshot.last_ping_ok
                ? "bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]"
                : "bg-neg-100 dark:bg-[#4d0218]/60 text-neg-700 dark:text-[#ff637e]"
            )}
            title={snapshot.last_ping_ok ? t("pingOk") : t("pingFailed")}
          >
            <RiPulseLine className="size-3" />
            {snapshot.last_ping_ms}ms
          </span>
        ) : null}
      </footer>

      <MetricDetailDialog
        open={openMetric !== null}
        onOpenChange={(o) => {
          if (!o) setOpenMetric(null)
        }}
        metric={openMetric ?? "cpu"}
        snapshot={snapshot}
        points={openMetric === "mem" ? memHistoryMB : cpuHistory}
      />
    </div>
  )
}

function FootStat({
  icon: Icon,
  label,
  value,
  alert,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  alert?: boolean
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className={cn("size-3", alert ? "text-amber-500" : "opacity-60")} />
      <span className="opacity-60">{label}</span>
      <span className={cn("text-foreground/80 tabular-nums", alert && "text-amber-600 dark:text-amber-400")}>
        {value}
      </span>
    </span>
  )
}
