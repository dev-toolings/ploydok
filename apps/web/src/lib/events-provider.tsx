// SPDX-License-Identifier: AGPL-3.0-only
//
// EventsProvider — ouvre UNE seule EventSource vers /events et multiplexe les
// events nommés auprès des consumers via Context. Remplace les EventSource
// multiples ouvertes par useNotifications + useMonitoringEvents.
//
// Reconnexion: la spec EventSource arrête le retry natif sur réponse non-2xx
// (typiquement 401 cookie expiré). On gère donc nous-mêmes le reconnect avec
// backoff exponentiel + refresh token avant chaque tentative.
//
// Usage:
//   <EventsProvider>          ← monté dans _authed.tsx (1 instance par session authed)
//     <App />
//   </EventsProvider>
//
//   // dans un hook consumer :
//   useEventsSubscription("container.health", (data) => { ... })

import * as React from "react"
import { triggerRefresh } from "./api"
import { apiBaseUrl } from "./api/base"
import { useBackendUnavailable } from "./backend-status"

type Listener = (data: unknown) => void
type Subscribe = (eventType: string, cb: Listener) => () => void

export type EventsStatus = "connecting" | "open" | "reconnecting" | "offline"

const SubscribeContext = React.createContext<Subscribe | null>(null)
const StatusContext = React.createContext<EventsStatus>("connecting")

const MAX_BACKOFF_MS = 30_000
const BASE_BACKOFF_MS = 1_000

export function EventsProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const backendUnavailable = useBackendUnavailable()
  const [status, setStatus] = React.useState<EventsStatus>("connecting")
  const listenersRef = React.useRef(new Map<string, Set<Listener>>())
  const abortRef = React.useRef<AbortController | null>(null)
  const attachedRef = React.useRef(new Set<string>())
  const esRef = React.useRef<EventSource | null>(null)
  const attemptRef = React.useRef(0)
  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (backendUnavailable.active) {
      teardown()
      setStatus("offline")
      return
    }

    const abort = new AbortController()
    abortRef.current = abort
    attemptRef.current = 0
    setStatus("connecting")

    void openConnection(abort)

    return () => {
      teardown()
    }

    function teardown(): void {
      abort.abort()
      if (abortRef.current === abort) abortRef.current = null
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      esRef.current?.close()
      esRef.current = null
      attachedRef.current = new Set<string>()
    }

    async function openConnection(currentAbort: AbortController): Promise<void> {
      // EventSource cannot retry through apiFetch's 401 refresh path.
      // Always refresh the access cookie before (re)opening the stream so
      // the SSE handshake doesn't get rejected on stale tokens.
      await triggerRefresh().catch(() => undefined)
      if (currentAbort.signal.aborted) return

      esRef.current?.close()
      const es = new EventSource(`${apiBaseUrl()}/events`, {
        withCredentials: true,
      })
      esRef.current = es
      attachedRef.current = new Set<string>()

      es.onopen = () => {
        if (currentAbort.signal.aborted) return
        attemptRef.current = 0
        setStatus("open")
      }

      es.onerror = () => {
        if (currentAbort.signal.aborted) return
        // Browser native retry will fire onopen again on transient errors.
        // We only schedule our own reconnect when the EventSource has been
        // permanently closed by the browser (CLOSED == non-2xx response).
        if (es.readyState === EventSource.CLOSED) {
          esRef.current?.close()
          esRef.current = null
          scheduleReconnect(currentAbort)
        } else {
          // Transient — surface the reconnecting state but let the browser
          // handle the retry. onopen will reset us to "open".
          setStatus("reconnecting")
        }
      }

      // Re-attach every event type already subscribed at the time of mount.
      // Needed if a consumer subscribed before the EventSource was opened.
      for (const eventType of listenersRef.current.keys()) {
        if (!attachedRef.current.has(eventType)) {
          attachListener(es, eventType, listenersRef.current, currentAbort.signal)
          attachedRef.current.add(eventType)
        }
      }
    }

    function scheduleReconnect(currentAbort: AbortController): void {
      if (currentAbort.signal.aborted) return
      const delay = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, attemptRef.current),
        MAX_BACKOFF_MS
      )
      attemptRef.current += 1
      setStatus("reconnecting")

      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        if (currentAbort.signal.aborted) return
        void openConnection(currentAbort)
      }, delay)
    }
  }, [backendUnavailable.active])

  const subscribe = React.useCallback<Subscribe>((eventType, cb) => {
    let set = listenersRef.current.get(eventType)
    if (!set) {
      set = new Set<Listener>()
      listenersRef.current.set(eventType, set)
    }
    set.add(cb)

    // Attach the DOM dispatcher at most once per type per EventSource,
    // tracked via attachedRef. Previous impl re-attached when the Set was
    // emptied then re-populated — that duplicated listener calls on every
    // resubscription (e.g. after a `connected` flip).
    const es = esRef.current
    const abort = abortRef.current
    if (es && abort && !attachedRef.current.has(eventType)) {
      attachListener(es, eventType, listenersRef.current, abort.signal)
      attachedRef.current.add(eventType)
    }

    return () => {
      const s = listenersRef.current.get(eventType)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) listenersRef.current.delete(eventType)
    }
  }, [])

  return (
    <SubscribeContext.Provider value={subscribe}>
      <StatusContext.Provider value={status}>{children}</StatusContext.Provider>
    </SubscribeContext.Provider>
  )
}

/** Attache un listener unique par type qui dispatch vers tous les abonnés. */
function attachListener(
  es: EventSource,
  eventType: string,
  map: Map<string, Set<Listener>>,
  signal: AbortSignal
): void {
  es.addEventListener(
    eventType,
    (ev: Event) => {
      const set = map.get(eventType)
      if (!set || set.size === 0) return
      const msgEvent = ev as MessageEvent<string>
      let parsed: unknown
      try {
        parsed = JSON.parse(msgEvent.data)
      } catch {
        return
      }
      for (const cb of set) {
        try {
          cb(parsed)
        } catch {
          // Subscriber errors must not crash the dispatcher.
        }
      }
    },
    { signal }
  )
}

function isReplayed(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { replay?: unknown }).replay === true
  )
}

export function useEventsSubscription<T>(
  eventType: string,
  callback: (data: T) => void,
  enabled = true,
  options: { replay?: boolean } = {}
): void {
  const acceptReplay = options.replay === true
  const subscribe = React.useContext(SubscribeContext)
  const cbRef = React.useRef(callback)
  React.useEffect(() => {
    cbRef.current = callback
  })

  React.useEffect(() => {
    if (!enabled) return
    if (!subscribe) return
    const unsub = subscribe(eventType, (data) => {
      // The server replays buffered history on every (re)connect, flagged with
      // `replay: true`. Only the notification bell wants it; data refreshes
      // and cache patches must react to live events only.
      if (!acceptReplay && isReplayed(data)) return
      cbRef.current(data as T)
    })
    return unsub
  }, [subscribe, eventType, enabled, acceptReplay])
}

export function useEventsStatus(): EventsStatus {
  return React.useContext(StatusContext)
}

/** Backward-compat boolean: true only when the stream is fully open. */
export function useEventsConnected(): boolean {
  return React.useContext(StatusContext) === "open"
}

/**
 * Imperative access to the SSE subscribe function. Lets callers arm a one-shot
 * listener (e.g. wait for the next `deploy.status_change` event for an app
 * after triggering a background restart) without React-Effect lifecycle.
 */
export function useEventsSubscribeFn(): Subscribe | null {
  return React.useContext(SubscribeContext)
}
