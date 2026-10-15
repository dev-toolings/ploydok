// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import {
  RiCloseCircleLine,
  RiComputerLine,
  RiErrorWarningLine,
  RiGlobalLine,
  RiMapPinLine,
  RiShieldCheckLine,
  RiSmartphoneLine,
  RiTimeLine,
} from "@remixicon/react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../lib/page-metadata"
import { SessionHistoryPopover } from "../../../../components/settings/SessionHistoryPopover"
import {
  useRevokeOthers,
  useRevokeSession,
  useSessions,
} from "../../../../lib/sessions"
import i18n from "../../../../lib/i18n"
import type { SessionInfo } from "@ploydok/shared"

export const Route = createFileRoute("/_authed/settings/security/sessions")({
  head: createPageHead("sessions"),
  component: SessionsPage,
})

function SessionsPage(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data: sessions, isLoading, error } = useSessions()
  const revokeOthers = useRevokeOthers()

  if (error) {
    return (
      <section className="rounded-2xl bg-panel p-4">
        <p
          role="alert"
          className="flex items-center gap-1.5 text-sm text-destructive"
        >
          <RiErrorWarningLine className="size-4" />
          {t("sessions.loadFailed", { message: error.message })}
        </p>
      </section>
    )
  }

  const others = sessions?.filter((s) => !s.is_current) ?? []
  const current = sessions?.find((s) => s.is_current)
  const sorted = [...(sessions ?? [])].sort((a, b) =>
    a.is_current === b.is_current ? 0 : a.is_current ? -1 : 1
  )

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">{t("sessions.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("sessions.hint")}
            </p>
          </div>
          <SessionHistoryPopover sessions={sorted} />
        </div>

        {isLoading ? (
          <div
            className="space-y-2 rounded-xl border border-dashed border-panel-border bg-panel-inset p-4"
            aria-busy="true"
            aria-label={t("sessions.loading")}
          >
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ) : sorted.length > 0 ? (
          <div className="space-y-3">
            {current ? (
              <ul className="space-y-2">
                <SessionRow session={current} />
              </ul>
            ) : null}

            {others.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex min-h-[58px] items-center justify-between gap-3 border-b border-border px-4">
                  <span className="text-[13px] font-medium">
                    {t("sessions.others", { count: others.length })}
                  </span>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="xs"
                        loading={revokeOthers.isPending}
                      >
                        <RiCloseCircleLine />
                        {t("sessions.signOutAll")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogMedia>
                          <RiCloseCircleLine />
                        </AlertDialogMedia>
                        <AlertDialogTitle>
                          {t("sessions.signOutAllConfirm")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("sessions.signOutAllHint")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t("common:cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          onClick={() => revokeOthers.mutate()}
                        >
                          {revokeOthers.isPending
                            ? t("sessions.signingOut")
                            : t("sessions.signThemOut")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                <ul className="divide-y divide-border">
                  {others.map((session) => (
                    <SessionRow key={session.id} session={session} compact />
                  ))}
                </ul>
              </div>
            ) : (
              <p className="px-1 text-xs text-muted-foreground">
                {t("sessions.noOthers")}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-panel-border bg-panel-inset px-4 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
              <RiComputerLine className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">{t("sessions.empty")}</p>
          </div>
        )}
      </section>

      {current ? (
        <p className="text-xs text-muted-foreground">
          {t("sessions.endCurrent")}
        </p>
      ) : null}
    </div>
  )
}

interface ParsedUA {
  os: string
  browser: string
  icon: React.ComponentType<{ className?: string }>
}

function parseUA(ua: string): ParsedUA {
  const unknownOs = i18n.t("settings:sessions.unknownOs")
  const unknownBrowser = i18n.t("settings:sessions.unknownBrowser")
  let os = unknownOs
  let browser = unknownBrowser
  if (/Windows/i.test(ua)) os = "Windows"
  else if (/iPhone/i.test(ua)) os = "iPhone"
  else if (/iPad/i.test(ua)) os = "iPad"
  else if (/Android/i.test(ua)) os = "Android"
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS"
  else if (/Linux/i.test(ua)) os = "Linux"

  if (/Edg\//i.test(ua)) browser = "Edge"
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera"
  else if (/Firefox\//i.test(ua)) browser = "Firefox"
  else if (/Chrome\//i.test(ua)) browser = "Chrome"
  else if (/Safari\//i.test(ua)) browser = "Safari"

  const icon =
    os === "iPhone" || os === "iPad" || os === "Android"
      ? RiSmartphoneLine
      : os === unknownOs
        ? RiGlobalLine
        : RiComputerLine

  return { os, browser, icon }
}

function SessionRow({
  session,
  compact = false,
}: {
  session: SessionInfo
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const revoke = useRevokeSession()
  const { os, browser, icon: Icon } = parseUA(session.user_agent)
  const pending = revoke.isPending && revoke.variables === session.id
  const lastSeenAbs = new Date(session.last_seen_at).toLocaleString()

  return (
    <li
      className={cn(
        "relative bg-card transition-colors",
        compact
          ? "hover:bg-muted/30"
          : session.is_current
            ? "rounded-xl border border-emerald-500/30 ring-1 ring-emerald-500/10"
            : "rounded-xl border border-border hover:bg-muted/30"
      )}
    >
      <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:gap-4">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-md",
            session.is_current
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-muted text-muted-foreground"
          )}
        >
          <Icon className="size-4" />
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">
              {browser}{" "}
              <span className="text-muted-foreground">
                {t("sessions.onOs", { os })}
              </span>
            </p>
            {session.is_current ? (
              <span className="relative inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                </span>
                {t("sessions.thisDevice")}
              </span>
            ) : null}
          </div>

          <dl className="flex flex-wrap gap-x-4 gap-y-0.5 font-sans text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1">
              <dt className="flex items-center gap-1 opacity-60">
                <RiMapPinLine className="size-3" />
                {t("sessions.ip")}
              </dt>
              <dd className="text-foreground/80">{session.ip}</dd>
            </div>
            <div className="flex items-center gap-1">
              <dt className="flex items-center gap-1 opacity-60">
                <RiTimeLine className="size-3" />
                {t("sessions.lastSeen")}
              </dt>
              <dd title={lastSeenAbs} className="text-foreground/80">
                {relativeTime(session.last_seen_at)}
              </dd>
            </div>
          </dl>

          <p
            className="truncate font-mono text-[10px] text-muted-foreground/70"
            title={session.user_agent}
          >
            {session.user_agent}
          </p>
        </div>

        <div className="shrink-0">
          {session.is_current ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              <RiShieldCheckLine className="size-3.5" />
              {t("sessions.trusted")}
            </span>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={pending}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t("sessions.revokeAria", { browser, os })}
                >
                  <RiCloseCircleLine />
                  {t("sessions.revoke")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogMedia>
                    <RiCloseCircleLine />
                  </AlertDialogMedia>
                  <AlertDialogTitle>
                    {t("sessions.revokeConfirm")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("sessions.revokeHint", {
                      browser,
                      os,
                      ip: session.ip,
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => revoke.mutate(session.id)}
                  >
                    {t("sessions.revokeSession")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </li>
  )
}

function relativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diff = now - then
  if (diff <= 0) return i18n.t("settings:relative.justNow")
  const s = Math.floor(diff / 1000)
  if (s < 45) return i18n.t("settings:relative.justNow")
  const m = Math.floor(s / 60)
  if (m < 60) return i18n.t("settings:relative.minutes", { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return i18n.t("settings:relative.hours", { count: h })
  const d = Math.floor(h / 24)
  if (d < 7) return i18n.t("settings:relative.days", { count: d })
  const w = Math.floor(d / 7)
  if (w < 5) return i18n.t("settings:relative.weeks", { count: w })
  const mo = Math.floor(d / 30)
  if (mo < 12) return i18n.t("settings:relative.months", { count: mo })
  return i18n.t("settings:relative.years", { count: Math.floor(d / 365) })
}
