// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { RiLoader4Line } from "@remixicon/react"
import { useNavigate } from "@tanstack/react-router"
import { useEventsSubscription } from "../../lib/events-provider"
import { resolveNotificationHref } from "../../lib/notification-destinations"
import { useCurrentOrganizationSlug } from "../../lib/organizations"
import type { NotificationEvent } from "../../lib/notifications"

// A build whose terminal event never arrived (worker crash) must not pin the
// indicator forever.
const STALE_AFTER_MS = 60 * 60 * 1000

// Replayed history is accepted so a reload mid-build keeps the indicator. The
// server replays the most recent events in order, so a finished build's
// terminal event is always replayed after its start and clears it.
function useRunningBuilds(): Array<NotificationEvent> {
  const [running, setRunning] = React.useState<Map<string, NotificationEvent>>(
    () => new Map()
  )

  const onStarted = React.useCallback((evt: NotificationEvent) => {
    const buildId = evt.buildId
    if (!buildId || !evt.appId) return
    if (Date.now() - evt.t > STALE_AFTER_MS) return
    setRunning((prev) => new Map(prev).set(buildId, evt))
  }, [])

  const onFinished = React.useCallback((evt: NotificationEvent) => {
    const buildId = evt.buildId
    if (!buildId) return
    setRunning((prev) => {
      if (!prev.has(buildId)) return prev
      const next = new Map(prev)
      next.delete(buildId)
      return next
    })
  }, [])

  const replay = { replay: true }
  useEventsSubscription("build.started", onStarted, true, replay)
  useEventsSubscription("build.succeeded", onFinished, true, replay)
  useEventsSubscription("build.failed", onFinished, true, replay)
  useEventsSubscription("build.cancelled", onFinished, true, replay)

  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (running.size === 0) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [running.size])

  return React.useMemo(
    () =>
      [...running.values()]
        .filter((evt) => now - evt.t <= STALE_AFTER_MS)
        .sort((a, b) => b.t - a.t),
    [running, now]
  )
}

export function BuildActivityIndicator(): React.JSX.Element | null {
  const { t } = useTranslation("common")
  const navigate = useNavigate()
  const orgSlug = useCurrentOrganizationSlug()
  const builds = useRunningBuilds()
  if (builds.length === 0) return null
  const latest = builds[0]

  const label = t("buildActivity.label", { count: builds.length })
  const href = resolveNotificationHref(latest, orgSlug)

  return (
    <button
      type="button"
      disabled={!href}
      onClick={() => {
        if (href) void navigate({ href })
      }}
      title={t("buildActivity.open")}
      aria-label={`${label}. ${t("buildActivity.open")}`}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:hover:bg-transparent"
    >
      <RiLoader4Line
        className="size-4 animate-spin text-primary"
        aria-hidden="true"
      />
      <span className="hidden whitespace-nowrap sm:inline">{label}</span>
    </button>
  )
}
