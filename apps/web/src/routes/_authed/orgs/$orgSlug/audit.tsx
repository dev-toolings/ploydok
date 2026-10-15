// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../lib/page-metadata"
import { ShellPage, ShellPanel } from "../../../../components/layout/AppShell"
import { useCurrentOrganization } from "../../../../lib/organizations"
import { useAuditEvents } from "../../../../lib/audit"
import i18n from "../../../../lib/i18n"
import type { AuditEvent } from "@ploydok/shared"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/audit")({
  head: createPageHead("audit"),
  component: AuditPage,
})

const ALL = "all"

function AuditPage(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const organization = useCurrentOrganization()
  const [actionPrefix, setActionPrefix] = useState<string>(ALL)
  const [targetType, setTargetType] = useState<string>(ALL)
  const [cursor, setCursor] = useState<number | undefined>()

  const filtersDirty =
    actionPrefix !== ALL || targetType !== ALL || cursor !== undefined

  const query = useAuditEvents(organization?.id, {
    cursor,
    actionPrefix: actionPrefix === ALL ? undefined : actionPrefix,
    targetType: targetType === ALL ? undefined : targetType,
  })

  return (
    <ShellPage
      title={t("audit.title")}
      eyebrow={t("eyebrow")}
      description={t("audit.description")}
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={!filtersDirty}
          onClick={() => {
            setActionPrefix(ALL)
            setTargetType(ALL)
            setCursor(undefined)
          }}
        >
          {t("audit.reset")}
        </Button>
      }
    >
      <ShellPanel
        title={t("audit.events")}
        description={t("audit.eventsHint")}
        action={
          <div className="flex flex-wrap gap-2">
            <Select value={actionPrefix} onValueChange={setActionPrefix}>
              <SelectTrigger className="h-9 w-44">
                <SelectValue placeholder={t("audit.action")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("audit.allActions")}</SelectItem>
                <SelectItem value="app.">{t("audit.applications")}</SelectItem>
                <SelectItem value="secret.">{t("audit.secrets")}</SelectItem>
                <SelectItem value="webhook.">{t("audit.webhooks")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={targetType} onValueChange={setTargetType}>
              <SelectTrigger className="h-9 w-44">
                <SelectValue placeholder={t("audit.type")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("audit.allTypes")}</SelectItem>
                <SelectItem value="app">{t("audit.application")}</SelectItem>
                <SelectItem value="secret">{t("audit.secret")}</SelectItem>
                <SelectItem value="webhook">{t("audit.webhook")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        {!organization || query.isLoading ? (
          <AuditTimelineSkeleton />
        ) : query.data && query.data.events.length > 0 ? (
          <div className="space-y-3">
            <div className="space-y-2">
              {query.data.events.map((event) => (
                <AuditEventRow key={event.id} event={event} />
              ))}
            </div>
            {query.data.nextCursor !== null &&
            query.data.nextCursor !== undefined ? (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setCursor(query.data?.nextCursor ?? undefined)}
              >
                {t("audit.loadMore")}
              </Button>
            ) : null}
          </div>
        ) : (
          <AuditEmpty />
        )}
      </ShellPanel>
    </ShellPage>
  )
}

function AuditEmpty(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  return (
    <div className="rounded-md border border-dashed border-panel-border bg-panel-inset px-6 py-12 text-center">
      <p className="text-sm font-semibold text-foreground">{t("audit.empty")}</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {t("audit.emptyHint")}
      </p>
    </div>
  )
}

function AuditEventRow({ event }: { event: AuditEvent }): React.JSX.Element {
  const relativeTime = getRelativeTime(event.created_at)
  const actionColor = getActionColor(event.action)

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-panel-border bg-panel-inset px-4 py-3 shadow-sm">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${actionColor}`}
        >
          {event.action}
        </span>
        <div className="min-w-0 text-sm">
          <p className="truncate font-medium text-foreground">
            {event.target_type} {event.target_id}
          </p>
          {event.user_id ? (
            <p className="truncate text-xs text-muted-foreground">
              {i18n.t("workspace:audit.byUser", { userId: event.user_id })}
            </p>
          ) : null}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {relativeTime}
      </span>
    </div>
  )
}

function AuditTimelineSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="flex items-center justify-between gap-4 rounded-xl border border-panel-border bg-panel-inset px-4 py-3 shadow-sm"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="h-5 w-20 skeleton-surface rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 w-48 skeleton-surface rounded" />
              <div className="h-3 w-32 skeleton-surface rounded" />
            </div>
          </div>
          <div className="h-3 w-16 skeleton-surface rounded" />
        </div>
      ))}
    </div>
  )
}

function getActionColor(action: string | undefined): string {
  if (!action) return "bg-muted text-muted-foreground"
  if (action.includes("created"))
    return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
  if (action.includes("deleted")) return "bg-destructive/10 text-destructive"
  if (action.includes("updated"))
    return "bg-blue-500/10 text-blue-600 dark:text-blue-400"
  return "bg-muted text-muted-foreground"
}

function getRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - new Date(date).getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return i18n.t("common:relative.justNow")
  if (diffMins < 60)
    return i18n.t("common:relative.minutesAgo", { count: diffMins })
  if (diffHours < 24)
    return i18n.t("common:relative.hoursAgo", { count: diffHours })
  if (diffDays < 7)
    return i18n.t("common:relative.daysAgo", { count: diffDays })
  return new Date(date).toLocaleDateString(i18n.language)
}
