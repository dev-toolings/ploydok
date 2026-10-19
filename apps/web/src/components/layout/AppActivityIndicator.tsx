// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { RiLoader4Line } from "@remixicon/react"
import { useEventsSubscription } from "../../lib/events-provider"
import type { NotificationEvent } from "../../lib/notifications"

// An operation whose terminal event never arrived (worker crash) must not pin
// the indicator forever.
const STALE_AFTER_MS = 30 * 60 * 1000

type PendingKind = "deleting" | "stopping"

interface PendingOperation {
  kind: PendingKind
  evt: NotificationEvent
}

// Deletion and stop run as server jobs after a 202. The queued event marks
// the operation in flight; the done or failed event clears it. Replayed
// history is accepted so a reload keeps the indicator, and a finished
// operation's terminal event always replays after its queued one.
function usePendingOperations(): Array<PendingOperation> {
  const [pending, setPending] = React.useState<Map<string, PendingOperation>>(
    () => new Map()
  )

  const start = React.useCallback(
    (kind: PendingKind) => (evt: NotificationEvent) => {
      if (!evt.appId) return
      if (Date.now() - evt.t > STALE_AFTER_MS) return
      setPending((prev) =>
        new Map(prev).set(`${kind}:${evt.appId}`, { kind, evt })
      )
    },
    []
  )

  const finish = React.useCallback(
    (kind: PendingKind) => (evt: NotificationEvent) => {
      if (!evt.appId) return
      setPending((prev) => {
        const key = `${kind}:${evt.appId}`
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })
    },
    []
  )

  const onDeleteQueued = React.useMemo(() => start("deleting"), [start])
  const onDeleteDone = React.useMemo(() => finish("deleting"), [finish])
  const onStopQueued = React.useMemo(() => start("stopping"), [start])
  const onStopDone = React.useMemo(() => finish("stopping"), [finish])

  const replay = { replay: true }
  useEventsSubscription("app.delete.queued", onDeleteQueued, true, replay)
  useEventsSubscription("app.deleted", onDeleteDone, true, replay)
  useEventsSubscription("app.delete.failed", onDeleteDone, true, replay)
  useEventsSubscription("app.stop.queued", onStopQueued, true, replay)
  useEventsSubscription("app.stopped", onStopDone, true, replay)
  useEventsSubscription("app.stop.failed", onStopDone, true, replay)

  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (pending.size === 0) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [pending.size])

  return React.useMemo(
    () =>
      [...pending.values()]
        .filter((op) => now - op.evt.t <= STALE_AFTER_MS)
        .sort((a, b) => b.evt.t - a.evt.t),
    [pending, now]
  )
}

export function AppActivityIndicator(): React.JSX.Element | null {
  const { t } = useTranslation("common")
  const operations = usePendingOperations()
  if (operations.length === 0) return null
  const latest = operations[0]

  const label =
    operations.length === 1
      ? t(`appActivity.${latest.kind}`)
      : t("appActivity.many", { count: operations.length })

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground"
    >
      <RiLoader4Line
        className="size-4 animate-spin text-primary"
        aria-hidden="true"
      />
      <span className="hidden whitespace-nowrap sm:inline">{label}</span>
    </div>
  )
}
