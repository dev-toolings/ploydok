// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Badge } from "@workspace/ui/components/badge"
import {
  RiAlarmWarningLine,
  RiArrowRightUpLine,
  RiDatabase2Line,
  RiGlobalLine,
  RiPlugLine,
  RiShieldCheckLine,
} from "@remixicon/react"
import {
  organizationPath,
  useCurrentOrganizationSlug,
} from "../../lib/organizations"
import {
  isDatabaseBackupScheduled,
  isDatabaseProtected,
} from "../../lib/database-list"
import { DatabaseStatusBadge } from "./DatabaseStatusBadge"
import type { Database } from "../../lib/databases"

const KIND_LABELS: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  redis: "Redis",
  mongo: "MongoDB",
  libsql: "SQLite / libSQL",
}

interface DatabaseCardProps {
  database: Database
}

function formatRelativeBackupDate(
  value: string | null | undefined,
  t: (key: string, options?: { date: string }) => string,
  lng: string
): string {
  if (!value) return t("card.noBackupCompleted")

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t("card.backupDateUnavailable")

  return t("card.lastBackup", {
    date: new Intl.DateTimeFormat(lng, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  })
}

function ProtectionBadge({
  database,
}: {
  database: Database
}): React.JSX.Element {
  const { t } = useTranslation("databases")
  if (database.management_mode === "external") {
    return <Badge variant="outline">{t("status.externalPolicy")}</Badge>
  }

  if (database.latest_backup_status === "failed") {
    return (
      <Badge variant="destructive">
        <RiAlarmWarningLine />
        {t("card.backupFailed")}
      </Badge>
    )
  }

  if (isDatabaseProtected(database)) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/25 bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]"
      >
        <RiShieldCheckLine />
        {t("card.lastBackupSucceeded")}
      </Badge>
    )
  }

  if (isDatabaseBackupScheduled(database)) {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/25 bg-warn-100 dark:bg-[#432004]/60 text-warn-700 dark:text-[#fdc700]"
      >
        <RiShieldCheckLine />
        {t("card.backupScheduled")}
      </Badge>
    )
  }

  return (
    <Badge variant="destructive">
      <RiAlarmWarningLine />
      {t("card.noBackup")}
    </Badge>
  )
}

export function DatabaseCard({
  database,
}: DatabaseCardProps): React.JSX.Element {
  const { t, i18n } = useTranslation("databases")
  const currentOrgSlug = useCurrentOrganizationSlug()
  const detailPath = currentOrgSlug
    ? organizationPath(currentOrgSlug, `databases/${database.id}`)
    : `/databases/${database.id}`

  const kindLabel = KIND_LABELS[database.kind] ?? database.kind
  const versionLabel =
    database.management_mode === "external"
      ? kindLabel
      : `${kindLabel} ${database.version}`
  const sourceLabel =
    database.management_mode === "external"
      ? t("card.external")
      : t(`plans.${database.plan}`, { defaultValue: database.plan })
  const endpoint = database.host
    ? `${database.host}:${database.port ?? "—"}`
    : t("card.endpointPending")
  const linked = database.linked_apps?.length ?? 0
  const backupFailed = database.latest_backup_status === "failed"

  return (
    <article className="group overflow-hidden rounded-[10px] bg-panel-inset transition-[border-color,background-color,transform] hover:-translate-y-0.5 hover:bg-accent/20 motion-reduce:hover:translate-y-0 shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]">
      <Link
        to={detailPath as never}
        className="block p-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground">
              <RiDatabase2Line className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {database.name}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {versionLabel} · {sourceLabel}
              </p>
            </div>
          </div>
          <DatabaseStatusBadge
            status={database.status}
            health={database.health_status}
            className="flex-col items-end sm:flex-row"
          />
        </div>

        <div className="mt-4 grid gap-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <RiPlugLine className="size-4 shrink-0" />
            <span className="truncate font-mono">{endpoint}</span>
          </div>
          <div className="flex items-center gap-2">
            <RiGlobalLine className="size-4 shrink-0" />
            <span className={database.public_enabled ? "text-destructive" : ""}>
              {database.public_enabled ? t("card.public") : t("card.internal")}
            </span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <ProtectionBadge database={database} />
          <Badge variant="outline">
            {linked > 0
              ? t("card.linkedApps", { count: linked })
              : t("card.noLinkedApp")}
          </Badge>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
          <span
            className={[
              "truncate text-xs",
              backupFailed ? "text-destructive" : "text-muted-foreground",
            ].join(" ")}
          >
            {backupFailed
              ? t("card.latestBackupFailed")
              : database.management_mode === "external"
                ? t("card.backupsExternal")
                : formatRelativeBackupDate(
                    database.latest_backup_at,
                    t,
                    i18n.language
                  )}
          </span>
          <RiArrowRightUpLine className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </div>
      </Link>
    </article>
  )
}
