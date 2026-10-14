// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "../api"
import { useEventsSubscription } from "../events-provider"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppEventType =
  | "build.started"
  | "build.succeeded"
  | "build.failed"
  | "build.cancelled"
  | "deploy.status_change"
  | "container.health"

export interface AppEvent {
  id: string
  type: AppEventType
  timestamp: number
  data: Record<string, unknown>
}

interface SsePayloadWithApp {
  appId?: string
  buildId?: string
  message?: string
  t?: number
  id?: string
  [key: string]: unknown
}

interface ActivityEventDto {
  id: string
  type: AppEventType
  timestamp: number
  buildId: string
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Pure helpers (extracted for testability)
// ---------------------------------------------------------------------------

export function eventBelongsToApp(
  _type: AppEventType,
  payload: SsePayloadWithApp,
  appId: string,
): boolean {
  return payload.appId === appId
}

export function buildAppEvent(
  type: AppEventType,
  payload: SsePayloadWithApp,
): AppEvent {
  const id =
    typeof payload.id === "string"
      ? payload.id
      : `${type}-${payload.buildId ?? ""}-${payload.t ?? Date.now()}`
  return {
    id,
    type,
    timestamp: typeof payload.t === "number" ? payload.t : Date.now(),
    data: payload,
  }
}

/**
 * Prepend an event to the list, dedup by id, and cap to `limit`.
 */
export function prependEvent(
  list: Array<AppEvent>,
  event: AppEvent,
  limit: number,
): Array<AppEvent> {
  if (list.some((e) => e.id === event.id)) return list
  return [event, ...list].slice(0, limit)
}

/**
 * Merge fetched history into the current event list. New ids are kept; the
 * resulting list stays sorted newest-first and is capped to `limit`.
 */
export function mergeHistory(
  current: Array<AppEvent>,
  history: Array<AppEvent>,
  limit: number,
): Array<AppEvent> {
  const seen = new Set(current.map((e) => e.id))
  const merged = [...current]
  for (const event of history) {
    if (seen.has(event.id)) continue
    merged.push(event)
    seen.add(event.id)
  }
  merged.sort((a, b) => b.timestamp - a.timestamp)
  return merged.slice(0, limit)
}

// Live event types we care about for the activity feed. `container.health`
// is excluded on purpose — it's continuous telemetry, not user-facing activity.
const SUBSCRIBED_TYPES = [
  "build.started",
  "build.succeeded",
  "build.failed",
  "build.cancelled",
  "deploy.status_change",
] as const satisfies ReadonlyArray<AppEventType>

/** @deprecated Kept for backwards compatibility with existing tests. */
const SUPPORTED_TYPES: Array<AppEventType> = [
  "build.started",
  "build.succeeded",
  "build.failed",
  "deploy.status_change",
  "container.health",
]

// ---------------------------------------------------------------------------
// useAppActivityHistory — one-shot fetch of the persisted timeline.
// ---------------------------------------------------------------------------

export function useAppActivityHistory(appId: string, limit: number) {
  return useQuery<Array<AppEvent>, Error>({
    queryKey: ["apps", appId, "activity", limit],
    queryFn: async () => {
      const res = await apiFetch<{ events: Array<ActivityEventDto> }>(
        `/apps/${appId}/activity?limit=${limit}`,
      )
      return res.events.map((e) => ({
        id: e.id,
        type: e.type,
        timestamp: e.timestamp,
        data: { ...e.data, buildId: e.buildId },
      }))
    },
    enabled: Boolean(appId),
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// useAppEvents
//
// Combines historical activity (from GET /apps/:id/activity) with the live
// SSE stream so the feed is never empty when builds exist for the app.
// ---------------------------------------------------------------------------

export function useAppEvents(appId: string, limit = 10): Array<AppEvent> {
  const [events, setEvents] = React.useState<Array<AppEvent>>([])
  const { data: history } = useAppActivityHistory(appId, limit)

  React.useEffect(() => {
    setEvents([])
  }, [appId])

  React.useEffect(() => {
    if (!history || history.length === 0) return
    setEvents((prev) => mergeHistory(prev, history, limit))
  }, [history, limit])

  const handleEvent = React.useCallback(
    (type: AppEventType) => (payload: unknown) => {
      const p = payload as SsePayloadWithApp
      if (!eventBelongsToApp(type, p, appId)) return
      const event = buildAppEvent(type, p)
      setEvents((prev) => prependEvent(prev, event, limit))
    },
    [appId, limit],
  )

  useEventsSubscription<SsePayloadWithApp>(
    "build.started",
    handleEvent("build.started"),
  )
  useEventsSubscription<SsePayloadWithApp>(
    "build.succeeded",
    handleEvent("build.succeeded"),
  )
  useEventsSubscription<SsePayloadWithApp>(
    "build.failed",
    handleEvent("build.failed"),
  )
  useEventsSubscription<SsePayloadWithApp>(
    "build.cancelled",
    handleEvent("build.cancelled"),
  )
  useEventsSubscription<SsePayloadWithApp>(
    "deploy.status_change",
    handleEvent("deploy.status_change"),
  )

  return events
}

export { SUBSCRIBED_TYPES, SUPPORTED_TYPES }
