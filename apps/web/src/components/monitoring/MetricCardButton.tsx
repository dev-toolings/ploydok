// SPDX-License-Identifier: AGPL-3.0-only
//
// MetricCardButton — instrument de mesure cliquable. Valeur courante en gros,
// delta discret, sparkline qui flotte en fond. Ouvre MetricDetailDialog au clic.

import * as React from "react"
import { RiCpuLine, RiDatabase2Line, RiExpandDiagonal2Line } from "@remixicon/react"

import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"

interface MetricCardButtonProps {
  metric: "cpu" | "mem"
  /** Valeur courante déjà formatée (ex. "0.42 %" ou "22.3 MB"). */
  value: string
  /** Ring buffer dans l'unité native (ex. % pour cpu, MB pour mem). */
  history: Array<number>
  /** Suffixe d'unité utilisé dans le label delta (ex. " %" ou " MB"). */
  unit: string
  onClick: () => void
}

const METRIC_STYLES = {
  cpu: {
    icon: RiCpuLine,
    labelKey: "host.cpu",
    text: "text-foreground",
    ring: "focus-visible:ring-ring",
    stroke: "currentColor",
  },
  mem: {
    icon: RiDatabase2Line,
    labelKey: "memory",
    text: "text-foreground",
    ring: "focus-visible:ring-ring",
    stroke: "currentColor",
  },
} as const

export function MetricCardButton({
  metric,
  value,
  history,
  unit,
  onClick,
}: MetricCardButtonProps): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const style = METRIC_STYLES[metric]
  const Icon = style.icon
  const label = t(style.labelKey)

  // Delta: dernier vs avant-dernier. `null` si <2 samples.
  const delta =
    history.length >= 2
      ? history[history.length - 1] - history[history.length - 2]
      : null

  const deltaLabel =
    delta === null
      ? null
      : `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta).toFixed(unit === " %" ? 2 : 1)}${unit}`

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("metricDetail", { label })}
      className={cn(
        "group/metric relative isolate flex w-full flex-col overflow-hidden",
        "rounded-md border border-border bg-muted/30 px-3 py-2.5 text-left",
        "transition-colors duration-200 ease-out hover:bg-muted/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        style.ring,
      )}
    >
      {/* Sparkline flottante en fond — SVG inline léger */}
      <InlineSparkline
        points={history}
        stroke={style.stroke}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-11 w-full text-primary opacity-[0.18]"
      />

      {/* Header: icon + label + expand hint */}
      <div className="relative z-10 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-3" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em]">
            {label}
          </span>
        </div>
        <RiExpandDiagonal2Line
          className={cn(
            "size-3 shrink-0 text-muted-foreground/30 transition-all duration-200",
            "group-hover/metric:text-muted-foreground group-hover/metric:rotate-45",
          )}
        />
      </div>

      {/* Hero value + delta */}
      <div className="relative z-10 mt-1.5 flex items-baseline gap-2">
        <span
          className={cn(
            "font-sans text-[22px] leading-none font-semibold tabular-nums",
            style.text,
          )}
        >
          {value}
        </span>
        {deltaLabel ? (
          <span className="font-sans text-[10px] leading-none tabular-nums text-muted-foreground">
            {deltaLabel}
          </span>
        ) : null}
      </div>

      {/* Spacer pour laisser respirer la sparkline en bas */}
      <div className="relative z-10 mt-2 h-4" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// InlineSparkline — SVG polyline ultra-light, scale auto-adaptatif.
// ---------------------------------------------------------------------------

interface InlineSparklineProps {
  points: Array<number>
  stroke: string
  className?: string
}

const SPARK_W = 120
const SPARK_H = 32

function InlineSparkline({
  points,
  stroke,
  className,
}: InlineSparklineProps): React.JSX.Element {
  const trimmed = points.slice(-60)

  if (trimmed.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        className={className}
        aria-hidden
      />
    )
  }

  const max = Math.max(...trimmed, 0.0001)
  const min = Math.min(...trimmed, 0)
  const range = Math.max(max - min, max * 0.1, 0.0001)

  const xStep = SPARK_W / (trimmed.length - 1)

  const pathPoints = trimmed
    .map((v, i) => {
      const x = i * xStep
      const y = SPARK_H - ((v - min) / range) * SPARK_H
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(" ")

  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden
    >
      <polyline
        points={pathPoints}
        fill="none"
        stroke={stroke}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
