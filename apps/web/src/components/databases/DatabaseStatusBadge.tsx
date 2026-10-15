// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import type { DbHealthStatus, DbStatus } from "../../lib/databases"

const STATUS_CONFIG: Record<DbStatus, { className: string; pulse: boolean }> = {
  creating: {
    className: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff]",
    pulse: true,
  },
  starting: {
    className: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff]",
    pulse: true,
  },
  running: {
    className: "bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]",
    pulse: false,
  },
  stopped: {
    className: "bg-muted text-muted-foreground",
    pulse: false,
  },
  degraded: {
    className: "bg-orange-100 dark:bg-[#441306]/60 text-orange-800 dark:text-[#ff8904]",
    pulse: true,
  },
  failed: {
    className: "bg-neg-100 dark:bg-[#4d0218]/60 text-neg-700 dark:text-[#ff637e]",
    pulse: false,
  },
}

const HEALTH_CONFIG: Record<
  DbHealthStatus,
  { className: string; pulse: boolean }
> = {
  unknown: {
    className: "bg-muted text-muted-foreground",
    pulse: false,
  },
  starting: {
    className: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff]",
    pulse: true,
  },
  healthy: {
    className: "bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]",
    pulse: false,
  },
  degraded: {
    className: "bg-orange-100 dark:bg-[#441306]/60 text-orange-800 dark:text-[#ff8904]",
    pulse: true,
  },
  unhealthy: {
    className: "bg-orange-100 dark:bg-[#441306]/60 text-orange-800 dark:text-[#ff8904]",
    pulse: true,
  },
}

interface DatabaseStatusBadgeProps {
  status: DbStatus
  health?: DbHealthStatus | null
  className?: string
}

function Pill({
  label,
  className,
  pulse,
  ariaLabel,
}: {
  label: string
  className: string
  pulse: boolean
  ariaLabel: string
}): React.JSX.Element {
  return (
    <span
      className={[
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-0.5 text-xs font-medium",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-label={ariaLabel}
    >
      <span
        className={[
          "size-1.5 rounded-full bg-current",
          pulse ? "animate-pulse" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

export function DatabaseStatusBadge({
  status,
  health,
  className,
}: DatabaseStatusBadgeProps): React.JSX.Element {
  const { t } = useTranslation("databases")
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.stopped
  const healthCfg = health ? HEALTH_CONFIG[health] : null
  const statusKey = STATUS_CONFIG[status] ? status : "stopped"
  const statusLabel = t(`status.${statusKey}`)

  return (
    <span
      className={["inline-flex shrink-0 items-center gap-1.5", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <Pill
        label={statusLabel}
        className={config.className}
        pulse={config.pulse}
        ariaLabel={t("status.aria", { label: statusLabel })}
      />
      {healthCfg && health ? (
        <Pill
          label={t(`health.${health}`)}
          className={healthCfg.className}
          pulse={healthCfg.pulse}
          ariaLabel={t("health.aria", { label: t(`health.${health}`) })}
        />
      ) : null}
    </span>
  )
}
