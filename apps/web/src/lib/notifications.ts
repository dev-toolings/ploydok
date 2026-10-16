// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useReducer } from "react"
import { toast } from "sonner"
import { apiFetch } from "./api"
import i18n from "./i18n"
import { useEventsConnected, useEventsSubscription } from "./events-provider"

// ---------------------------------------------------------------------------
// Types — duplicated from API contract intentionally.
// Future cleanup: promote to packages/shared when stable.
// ---------------------------------------------------------------------------

export type NotificationType =
  | "build.started"
  | "build.succeeded"
  | "build.failed"
  | "build.cancelled"
  | "deploy.status_change"
  | "container.health"
  | "provider.sync.started"
  | "provider.sync.completed"
  | "provider.sync.failed"
  | "app.delete.queued"
  | "app.deleted"
  | "app.delete.failed"
  | "app.stop.queued"
  | "app.stopped"
  | "app.stop.failed"

export interface NotificationEvent {
  id: string
  type: NotificationType
  appId?: string
  buildId?: string
  message: string
  t: number
  data?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// State + reducer
// ---------------------------------------------------------------------------

export interface NotificationsState {
  items: Array<NotificationEvent>
  /** Number of items strictly newer than `lastReadAt`. */
  unreadCount: number
  /** Server-persisted cursor — events with t <= lastReadAt are pre-read. */
  lastReadAt: number
  /** True once the cursor has been hydrated from the API at least once. */
  hydrated: boolean
  connected: boolean
}

const MAX_ITEMS = 20

type Action =
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "push"; payload: NotificationEvent }
  | { type: "hydrate"; lastReadAt: number }
  | { type: "markAllRead"; at: number }
  | { type: "markAllReadRollback"; lastReadAt: number }
  | { type: "clear" }

const initialState: NotificationsState = {
  items: [],
  unreadCount: 0,
  lastReadAt: 0,
  hydrated: false,
  connected: false,
}

export function notificationsReducer(
  state: NotificationsState,
  action: Action,
): NotificationsState {
  switch (action.type) {
    case "connect":
      return { ...state, connected: true }

    case "disconnect":
      return { ...state, connected: false }

    case "hydrate": {
      // Recompute unreadCount against the server cursor.
      const unread = state.items.filter((it) => it.t > action.lastReadAt).length
      return {
        ...state,
        lastReadAt: action.lastReadAt,
        unreadCount: unread,
        hydrated: true,
      }
    }

    case "push": {
      // host.stats is a 2s telemetry frame. It shares the user channel with
      // notifications but must not enter the bell or bump the unread count.
      if ((action.payload.type as string) === "host.stats") return state
      // Dedup by event id — SSE replay on reconnect can re-deliver the same
      // event, and a future at-least-once bus would too.
      if (state.items.some((it) => it.id === action.payload.id)) return state
      const items = [action.payload, ...state.items].slice(0, MAX_ITEMS)
      const isUnread = action.payload.t > state.lastReadAt
      return {
        ...state,
        items,
        unreadCount: isUnread ? state.unreadCount + 1 : state.unreadCount,
      }
    }

    case "markAllRead":
      return { ...state, unreadCount: 0, lastReadAt: action.at }

    case "markAllReadRollback": {
      // Restore a previous cursor after a failed POST /events/mark-read,
      // then recompute unreadCount against it.
      const unread = state.items.filter((it) => it.t > action.lastReadAt).length
      return { ...state, lastReadAt: action.lastReadAt, unreadCount: unread }
    }

    case "clear":
      return { ...state, items: [], unreadCount: 0 }

    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Hook — s'abonne au stream /events partagé via EventsProvider.
// Persiste le curseur "lu jusqu'à" côté serveur (POST /events/mark-read) pour
// que le compteur ne se ré-incrémente pas après refresh.
// ---------------------------------------------------------------------------

export function useNotifications(): {
  state: NotificationsState
  markAllRead: () => void
  clear: () => void
} {
  const [state, dispatch] = useReducer(notificationsReducer, initialState)
  const connected = useEventsConnected()

  // Reflect provider connection status into the notifications state.
  useEffect(() => {
    dispatch({ type: connected ? "connect" : "disconnect" })
  }, [connected])

  // Hydrate the read cursor from the server on mount. Without this, every
  // refresh resets unreadCount to 0 then the SSE replay re-bumps it.
  // Retry once after 2 s on failure: a transient 401 during token refresh or
  // a cold-start network blip would otherwise strand the cursor at 0 and
  // leave the badge inflated until the user clicks "mark all read".
  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const run = async (attempt: number): Promise<void> => {
      try {
        const res = await apiFetch<{ lastReadAt: string | null }>("/events/read-state")
        if (cancelled) return
        const ms = res.lastReadAt ? new Date(res.lastReadAt).getTime() : 0
        dispatch({ type: "hydrate", lastReadAt: ms })
      } catch (err) {
        if (cancelled) return
        if (attempt === 0) {
          retryTimer = setTimeout(() => {
            if (!cancelled) void run(1)
          }, 2000)
          return
        }
        console.warn("notifications: failed to hydrate read cursor", err)
      }
    }

    void run(0)
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [])

  // Un abonnement par type — appels stables dans le même ordre à chaque render.
  const push = (payload: NotificationEvent) => dispatch({ type: "push", payload })
  useEventsSubscription<NotificationEvent>("build.started", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("build.succeeded", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("build.failed", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("build.cancelled", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("deploy.status_change", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("container.health", push, true, {
    replay: true,
  })
  // host.stats is continuous telemetry for the host cards. Do not subscribe:
  // the reducer also drops it, so a generic fan-out cannot count it.
  // provider.sync.progress is intentionally NOT subscribed: it fires once per
  // page (potentially dozens per sync) and would flood the bell. The dialog
  // consumes it directly.
  useEventsSubscription<NotificationEvent>("provider.sync.started", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("provider.sync.completed", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("provider.sync.failed", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("app.delete.queued", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("app.deleted", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("app.delete.failed", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("app.stop.queued", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("app.stopped", push, true, {
    replay: true,
  })
  useEventsSubscription<NotificationEvent>("app.stop.failed", push, true, {
    replay: true,
  })

  const markAllRead = () => {
    const previousLastReadAt = state.lastReadAt
    const at = Date.now()
    dispatch({ type: "markAllRead", at })
    // apiFetch already JSON-stringifies the body — pass the object directly,
    // not a pre-encoded string (double-encoding made the server fall back to
    // an empty body and the cursor was never persisted).
    void apiFetch("/events/mark-read", {
      method: "POST",
      body: { at: new Date(at).toISOString() },
    }).catch((err) => {
      // Revert the optimistic update: without this the badge reappears at
      // the next refresh (the server still serves the old cursor) and the
      // user loses the "I cleared it" signal.
      console.warn("notifications: failed to persist read cursor", err)
      dispatch({ type: "markAllReadRollback", lastReadAt: previousLastReadAt })
      toast.error(i18n.t("settings:notifications.markReadFailed"))
    })
  }
  const clear = () => dispatch({ type: "clear" })

  return { state, markAllRead, clear }
}
