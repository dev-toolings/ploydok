// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningLine,
  RiQuestionLine,
} from "@remixicon/react"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import {  useSystemHealth } from "../../lib/system-health"
import type {ComponentStatus} from "../../lib/system-health";

const STATUS_STYLES: Record<
  ComponentStatus,
  {
    icon: React.ComponentType<{ className?: string }>
    textKey: "system.ok" | "system.degradedBadge" | "down" | "system.unknown"
    cls: string
  }
> = {
  ok: {
    icon: RiCheckboxCircleFill,
    textKey: "system.ok",
    cls: "text-emerald-600 dark:text-emerald-400",
  },
  degraded: {
    icon: RiErrorWarningLine,
    textKey: "system.degradedBadge",
    cls: "text-amber-600 dark:text-amber-400",
  },
  down: {
    icon: RiCloseCircleFill,
    textKey: "down",
    cls: "text-destructive",
  },
  unknown: {
    icon: RiQuestionLine,
    textKey: "system.unknown",
    cls: "text-muted-foreground",
  },
}

export function SystemHealthCard(): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const { data, isLoading, error } = useSystemHealth()

  if (isLoading) {
    return (
      <div className="rounded-2xl bg-panel p-4">
        <div className="h-4 w-24 rounded skeleton-surface" />
        <div className="mt-3 grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 rounded skeleton-surface" />
          ))}
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <p className="font-sans text-xs opacity-80">
          system_health_unreachable
        </p>
        <p className="mt-1 text-xs">
          {error?.message ?? t("system.noData")}
        </p>
      </div>
    )
  }

  return (
    <section
      aria-label={t("system.title")}
      className="rounded-2xl bg-panel"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="space-y-0.5">
          <p className="font-sans text-xs text-muted-foreground">
            {t("system.label")}
          </p>
          <p className="text-sm font-medium">
            {data.ok ? t("system.operational") : t("system.degraded")}{" "}
            <span className="ml-1 font-sans text-[10px] text-muted-foreground">
              v{data.version}
            </span>
          </p>
        </div>
        <span
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium",
            data.ok
              ? "bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]"
              : "bg-warn-100 dark:bg-[#432004]/60 text-warn-700 dark:text-[#fdc700]"
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              data.ok ? "bg-emerald-500" : "bg-amber-500"
            )}
          />
          {data.ok ? t("system.operationalBadge") : t("system.degradedBadge")}
        </span>
      </header>
      <dl className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <ComponentCell
          label={t("system.database")}
          status={data.components.db.status}
          detail={
            data.components.db.latency_ms !== undefined
              ? `${data.components.db.latency_ms} ms`
              : data.components.db.error
          }
        />
        <ComponentCell
          label={t("system.agent")}
          status={data.components.agent.status}
          detail={data.components.agent.socket ?? data.components.agent.error}
        />
        <ComponentCell
          label={t("system.caddy")}
          status={data.components.caddy.status}
          detail={
            data.components.caddy.admin_url ?? data.components.caddy.error
          }
        />
      </dl>
    </section>
  )
}

function ComponentCell({
  label,
  status,
  detail,
}: {
  label: string
  status: ComponentStatus
  detail?: string
}): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const s = STATUS_STYLES[status]
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <dt className="font-sans text-xs text-muted-foreground">
        {label}
      </dt>
      <dd className="flex items-center gap-1.5">
        <s.icon className={cn("size-4", s.cls)} />
        <span className={cn("text-sm font-medium", s.cls)}>{t(s.textKey)}</span>
      </dd>
      {detail ? (
        <p
          className="truncate font-mono text-[10px] text-muted-foreground"
          title={detail}
        >
          {detail}
        </p>
      ) : null}
    </div>
  )
}
