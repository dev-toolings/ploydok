// SPDX-License-Identifier: AGPL-3.0-only
//
// useDeploymentToasts — surface un toast sonner à chaque fin de build.
// Monté une seule fois dans _authed.tsx pour éviter les doublons.
//
// Anti-replay : le ring-buffer serveur rejoue jusqu'à 20 events au reconnect
// SSE. Sans garde, tous les builds terminés passés déclencheraient un toast
// au mount. `mountedAt` filtre ces events : on n'affiche que ce qui est
// arrivé APRÈS le montage du hook.

import * as React from "react"
import { toast } from "sonner"
import { useQueryClient } from "@tanstack/react-query"
import { useEventsSubscription } from "./events-provider"
import { invalidateGetCache } from "./api"
import { toastDeleteOutcome } from "./delete-outcome"
import {
  markAppDeletingInListCaches,
  markAppStoppedInListCaches,
  removeAppFromListCaches,
} from "./apps-mutations"
import type { NotificationEvent } from "./notifications"

function toastIdForBuild(evt: NotificationEvent): string | undefined {
  return evt.buildId ? `deploy:${evt.buildId}` : undefined
}

export function useDeploymentToasts(): void {
  const mountedAt = React.useRef(Date.now())
  const qc = useQueryClient()

  const onStarted = React.useCallback((evt: NotificationEvent) => {
    if (evt.t < mountedAt.current) return
    if (!evt.buildId) return
    toast.loading(evt.message, { id: toastIdForBuild(evt) })
  }, [])

  const onDeployStatusChange = React.useCallback((evt: NotificationEvent) => {
    if (evt.t < mountedAt.current) return
    if (!evt.buildId) return
    toast.loading(evt.message, { id: toastIdForBuild(evt) })
  }, [])

  const onSucceeded = React.useCallback((evt: NotificationEvent) => {
    if (evt.t < mountedAt.current) return
    toast.success(evt.message, { id: toastIdForBuild(evt) })
  }, [])

  const onFailed = React.useCallback((evt: NotificationEvent) => {
    if (evt.t < mountedAt.current) return
    toast.error(evt.message, { id: toastIdForBuild(evt) })
  }, [])

  const onCancelled = React.useCallback((evt: NotificationEvent) => {
    if (evt.t < mountedAt.current) return
    toast.error(evt.message, { id: toastIdForBuild(evt) })
  }, [])

  // App delete cascade is async: DELETE /apps/:id returns 202 and the worker
  // emits app.deleted / app.delete.failed once Docker + registry + Caddy + DB
  // row are wiped. We upgrade the loading toast posted by useDeleteApp and
  // bust the apps caches here, mounted once at the _authed layout — robust
  // to the user navigating away from the detail page before completion.
  const onAppDeleteQueued = React.useCallback((evt: NotificationEvent) => {
    if (evt.t < mountedAt.current) return
    if (!evt.appId) return
    markAppDeletingInListCaches(qc, evt.appId)
    toast.loading(evt.message, { id: `delete-app:${evt.appId}` })
  }, [qc])

  const onAppDeleted = React.useCallback(
    (evt: NotificationEvent) => {
      if (evt.t < mountedAt.current) return
      if (!evt.appId) return
      invalidateGetCache()
      removeAppFromListCaches(qc, evt.appId)
      qc.removeQueries({ queryKey: ["apps", evt.appId] })
      void qc.invalidateQueries({ queryKey: ["apps"] })
      toastDeleteOutcome(evt, toast)
    },
    [qc]
  )

  const onAppDeleteFailed = React.useCallback(
    (evt: NotificationEvent) => {
      if (evt.t < mountedAt.current) return
      if (!evt.appId) return
      invalidateGetCache()
      void qc.invalidateQueries({ queryKey: ["apps"] })
      toastDeleteOutcome(evt, toast)
    },
    [qc]
  )

  const onAppStopQueued = React.useCallback((evt: NotificationEvent) => {
    if (evt.t < mountedAt.current) return
    if (!evt.appId) return
    toast.loading(evt.message, { id: `stop-app:${evt.appId}` })
  }, [])

  const onAppStopped = React.useCallback(
    (evt: NotificationEvent) => {
      if (evt.t < mountedAt.current) return
      if (!evt.appId) return
      invalidateGetCache()
      markAppStoppedInListCaches(qc, evt.appId)
      void qc.invalidateQueries({ queryKey: ["apps", evt.appId] })
      void qc.invalidateQueries({ queryKey: ["apps"] })
      toast.success(evt.message, { id: `stop-app:${evt.appId}` })
    },
    [qc]
  )

  const onAppStopFailed = React.useCallback(
    (evt: NotificationEvent) => {
      if (evt.t < mountedAt.current) return
      if (!evt.appId) return
      invalidateGetCache()
      void qc.invalidateQueries({ queryKey: ["apps", evt.appId] })
      void qc.invalidateQueries({ queryKey: ["apps"] })
      toast.error(evt.message, { id: `stop-app:${evt.appId}` })
    },
    [qc]
  )

  useEventsSubscription<NotificationEvent>("build.started", onStarted)
  useEventsSubscription<NotificationEvent>(
    "deploy.status_change",
    onDeployStatusChange
  )
  useEventsSubscription<NotificationEvent>("build.succeeded", onSucceeded)
  useEventsSubscription<NotificationEvent>("build.failed", onFailed)
  useEventsSubscription<NotificationEvent>("build.cancelled", onCancelled)
  useEventsSubscription<NotificationEvent>("app.delete.queued", onAppDeleteQueued)
  useEventsSubscription<NotificationEvent>("app.deleted", onAppDeleted)
  useEventsSubscription<NotificationEvent>(
    "app.delete.failed",
    onAppDeleteFailed
  )
  useEventsSubscription<NotificationEvent>("app.stop.queued", onAppStopQueued)
  useEventsSubscription<NotificationEvent>("app.stopped", onAppStopped)
  useEventsSubscription<NotificationEvent>("app.stop.failed", onAppStopFailed)
}
