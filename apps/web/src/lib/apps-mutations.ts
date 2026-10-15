// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch, invalidateGetCache } from "./api"
import i18n from "./i18n"
import { normalizeAppDetail } from "./apps"
import { notifyMutationError } from "./second-factor-toast"
import { useEventsSubscribeFn } from "./events-provider"
import type {
  AppDetail,
  AppListItem,
  AppSettingsPatch,
  RawAppDetail,
} from "./apps"
import type { ApiError } from "./api"
import type { QueryClient, QueryKey } from "@tanstack/react-query"

// ---------------------------------------------------------------------------
// useTrackAppRestart
//
// Returns a `track()` callback that shows a toast.loading and resolves it on
// the next `deploy.status_change` SSE event for this appId with a terminal
// status (running → success, failed/stopped → error). A timeout dismisses
// the toast if no event arrives.
// ---------------------------------------------------------------------------

function useTrackAppRestart(appId: string): () => void {
  const subscribe = useEventsSubscribeFn()
  return React.useCallback(() => {
    if (!subscribe) return
    const toastId = `app-restart-${appId}`
    toast.loading(i18n.t("apps:toasts.restarting"), { id: toastId })

    let unsubscribe: (() => void) | null = null
    const finish = () => {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => {
      finish()
      toast.dismiss(toastId)
    }, 180_000)

    unsubscribe = subscribe("deploy.status_change", (data) => {
      const evt = data as {
        appId?: string
        data?: { status?: string }
      }
      if (evt.appId !== appId) return
      const status = evt.data?.status
      if (status === "running") {
        finish()
        toast.success(i18n.t("apps:toasts.restarted"), { id: toastId })
      } else if (status === "failed") {
        finish()
        toast.error(i18n.t("apps:toasts.restartFailed"), { id: toastId })
      } else if (status === "stopped") {
        finish()
        toast.error(i18n.t("apps:toasts.restartInterrupted"), { id: toastId })
      }
    })
  }, [appId, subscribe])
}

const DELETE_APP_TOAST_TIMEOUT_MS = 10 * 60 * 1000
const STOP_APP_TOAST_TIMEOUT_MS = 3 * 60 * 1000

function useTrackAppDelete(appId: string): (jobId: string) => void {
  const subscribe = useEventsSubscribeFn()
  const qc = useQueryClient()
  return React.useCallback(
    (jobId: string) => {
      const toastId = `delete-app:${appId}`

      if (typeof window === "undefined") {
        toast.loading(i18n.t("apps:toasts.deleting"), { id: toastId })
        return
      }

      let cleanup = () => {}
      const completion = new Promise<string>((resolve, reject) => {
        let unsubDeleted: (() => void) | null = null
        let unsubFailed: (() => void) | null = null
        let pollTimer: number | undefined
        let finished = false
        const timer = window.setTimeout(() => {
          cleanup()
          reject(new Error(i18n.t("apps:toasts.deleteStillRunning")))
        }, DELETE_APP_TOAST_TIMEOUT_MS)

        cleanup = () => {
          finished = true
          window.clearTimeout(timer)
          window.clearTimeout(pollTimer)
          unsubDeleted?.()
          unsubDeleted = null
          unsubFailed?.()
          unsubFailed = null
        }

        unsubDeleted =
          subscribe?.("app.deleted", (data) => {
            const evt = data as { appId?: string; message?: string }
            if (evt.appId !== appId) return
            cleanup()
            resolve(evt.message ?? i18n.t("apps:toasts.deleted"))
          }) ?? null

        unsubFailed =
          subscribe?.("app.delete.failed", (data) => {
            const evt = data as { appId?: string; message?: string }
            if (evt.appId !== appId) return
            cleanup()
            reject(new Error(evt.message ?? i18n.t("apps:toasts.deleteFailed")))
          }) ?? null

        const reconcile = async (): Promise<void> => {
          try {
            const { job } = await apiFetch<{
              job: { status: string; errorMessage: string | null }
            }>(`/apps/deletion-jobs/${encodeURIComponent(jobId)}`)
            if (finished) return
            if (job.status === "succeeded") {
              cleanup()
              invalidateGetCache()
              removeAppFromListCaches(qc, appId)
              qc.removeQueries({ queryKey: ["apps", appId] })
              resolve(i18n.t("apps:toasts.deleted"))
              return
            }
            if (job.status === "failed" || job.status === "cancelled") {
              cleanup()
              invalidateGetCache()
              void qc.invalidateQueries({ queryKey: ["apps"] })
              reject(
                new Error(
                  job.errorMessage ?? i18n.t("apps:toasts.deleteFailed")
                )
              )
              return
            }
          } catch {
            // A temporary network failure is not evidence of job completion.
          }
          if (!finished)
            pollTimer = window.setTimeout(() => void reconcile(), 2_000)
        }
        void reconcile()
      })

      toast.promise(completion, {
        id: toastId,
        loading: i18n.t("apps:toasts.deleting"),
        success: (message) => message,
        error: (err) =>
          err instanceof Error
            ? err.message
            : i18n.t("apps:toasts.deleteFailed"),
      })
    },
    [appId, subscribe, qc]
  )
}

function useTrackAppStop(appId: string): () => void {
  const subscribe = useEventsSubscribeFn()
  return React.useCallback(() => {
    const toastId = `stop-app:${appId}`

    if (!subscribe || typeof window === "undefined") {
      toast.loading(i18n.t("apps:toasts.stopping"), { id: toastId })
      return
    }

    let cleanup = () => {}
    const completion = new Promise<string>((resolve, reject) => {
      let unsubStopped: (() => void) | null = null
      let unsubFailed: (() => void) | null = null
      const timer = window.setTimeout(() => {
        cleanup()
        reject(new Error(i18n.t("apps:toasts.stopStillRunning")))
      }, STOP_APP_TOAST_TIMEOUT_MS)

      cleanup = () => {
        window.clearTimeout(timer)
        unsubStopped?.()
        unsubStopped = null
        unsubFailed?.()
        unsubFailed = null
      }

      unsubStopped = subscribe("app.stopped", (data) => {
        const evt = data as { appId?: string; message?: string }
        if (evt.appId !== appId) return
        cleanup()
        resolve(evt.message ?? i18n.t("apps:toasts.stopped"))
      })

      unsubFailed = subscribe("app.stop.failed", (data) => {
        const evt = data as { appId?: string; message?: string }
        if (evt.appId !== appId) return
        cleanup()
        reject(new Error(evt.message ?? i18n.t("apps:toasts.stopFailed")))
      })
    })

    toast.promise(completion, {
      id: toastId,
      loading: i18n.t("apps:toasts.stopping"),
      success: (message) => message,
      error: (err) =>
        err instanceof Error ? err.message : i18n.t("apps:toasts.stopFailed"),
    })
  }, [appId, subscribe])
}

// ---------------------------------------------------------------------------
// useDeployApp
// ---------------------------------------------------------------------------

export interface DeployOptions {
  rebuild?: boolean
  noCache?: boolean
}

export function useDeployApp(appId: string) {
  const qc = useQueryClient()
  return useMutation<{ jobId: string }, ApiError, DeployOptions | void>({
    mutationFn: (opts) =>
      apiFetch<{ jobId: string }>(`/apps/${appId}/deploy`, {
        method: "POST",
        body: opts && (opts.rebuild || opts.noCache) ? opts : undefined,
      }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["apps", appId] })
      const snapshot = qc.getQueryData<AppDetail>(["apps", appId])
      if (snapshot) {
        qc.setQueryData<AppDetail>(["apps", appId], {
          ...snapshot,
          status: "building",
        })
      }
      qc.setQueryData<Array<AppListItem> | undefined>(["apps"], (current) =>
        current?.map((app) =>
          app.id === appId ? { ...app, status: "building" } : app
        )
      )
      return { snapshot }
    },
    onError: (err, _vars, context) => {
      notifyMutationError(err, i18n.t("apps:toasts.deployFailed"))
      const ctx = context as { snapshot?: AppDetail } | undefined
      if (ctx?.snapshot) {
        qc.setQueryData(["apps", appId], ctx.snapshot)
      }
      void qc.invalidateQueries({ queryKey: ["apps"] })
    },
    onSuccess: () => {
      toast.success(i18n.t("apps:toasts.queued"))
      void qc.invalidateQueries({ queryKey: ["apps", appId] })
      void qc.invalidateQueries({ queryKey: ["apps", appId, "builds"] })
      void qc.invalidateQueries({ queryKey: ["apps"] })
    },
  })
}

// ---------------------------------------------------------------------------
// useRollbackApp
// ---------------------------------------------------------------------------

export interface RollbackOptions {
  /** When provided, rollback to this specific succeeded build. Omit for legacy (previous build). */
  buildId?: string
}

export function useRollbackApp(appId: string) {
  const qc = useQueryClient()
  return useMutation<{ ok: boolean }, ApiError, RollbackOptions | void>({
    mutationFn: (opts) =>
      apiFetch<{ ok: boolean }>(`/apps/${appId}/rollback`, {
        method: "POST",
        body: opts?.buildId ? { buildId: opts.buildId } : undefined,
      }),
    onSuccess: () => {
      toast.success(i18n.t("apps:toasts.rollbackStarted"))
      void qc.invalidateQueries({ queryKey: ["apps", appId] })
      void qc.invalidateQueries({ queryKey: ["apps", appId, "builds"] })
    },
    onError: (error) => {
      notifyMutationError(error, i18n.t("apps:toasts.rollbackFailed"))
    },
  })
}

// ---------------------------------------------------------------------------
// useCancelBuild
// ---------------------------------------------------------------------------

export function useCancelBuild(appId: string) {
  const qc = useQueryClient()
  return useMutation<{ ok: boolean }, ApiError, { buildId: string }>({
    mutationFn: ({ buildId }) =>
      apiFetch<{ ok: boolean }>(`/apps/${appId}/builds/${buildId}/cancel`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success(i18n.t("apps:toasts.cancelled"))
      void qc.invalidateQueries({ queryKey: ["apps", appId] })
      void qc.invalidateQueries({ queryKey: ["apps", appId, "builds"] })
    },
    onError: (error) => {
      notifyMutationError(error, i18n.t("apps:toasts.cancelFailed"))
    },
  })
}

// ---------------------------------------------------------------------------
// useStopApp
// ---------------------------------------------------------------------------

export function useStopApp(appId: string) {
  const qc = useQueryClient()
  const trackStop = useTrackAppStop(appId)
  return useMutation<{ ok: boolean }, ApiError, void>({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`/apps/${appId}/stop`, { method: "POST" }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["apps", appId] })
      const snapshot = qc.getQueryData<AppDetail>(["apps", appId])
      const listSnapshot = snapshotAppListCaches(qc)
      if (snapshot) {
        qc.setQueryData<AppDetail>(["apps", appId], {
          ...snapshot,
          status: "stopped",
        })
      }
      markAppStoppedInListCaches(qc, appId)
      trackStop()
      return { snapshot, listSnapshot }
    },
    onError: (err, _vars, context) => {
      toast.dismiss(`stop-app:${appId}`)
      notifyMutationError(err, i18n.t("apps:toasts.stopFailed"))
      const ctx =
        context as
          | { snapshot?: AppDetail; listSnapshot?: AppListCacheSnapshot }
          | undefined
      if (ctx?.snapshot) {
        qc.setQueryData(["apps", appId], ctx.snapshot)
      }
      restoreAppListCaches(qc, ctx?.listSnapshot)
      void qc.invalidateQueries({ queryKey: ["apps"] })
    },
    onSuccess: () => {},
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["apps", appId] })
    },
  })
}

// ---------------------------------------------------------------------------
// useRestartApp
// ---------------------------------------------------------------------------

export function useRestartApp(appId: string) {
  const qc = useQueryClient()
  const trackRestart = useTrackAppRestart(appId)
  return useMutation<void, ApiError, void>({
    mutationFn: () =>
      apiFetch<void>(`/apps/${appId}/restart`, { method: "POST" }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["apps", appId] })
      const snapshot = qc.getQueryData<AppDetail>(["apps", appId])
      if (snapshot) {
        qc.setQueryData<AppDetail>(["apps", appId], {
          ...snapshot,
          status: "restarting",
        })
      }
      // The API returns 202 as soon as the prelude is committed; the heavy
      // work runs in the background and emits a `deploy.status_change` SSE
      // ("running" or "failed") when finished. Show a toast.loading now and
      // resolve it on the SSE event so the toast tracks the actual restart.
      trackRestart()
      return { snapshot }
    },
    onError: (err, _vars, context) => {
      notifyMutationError(err, i18n.t("apps:toasts.restartFailed"))
      const ctx = context as { snapshot?: AppDetail } | undefined
      if (ctx?.snapshot) {
        qc.setQueryData(["apps", appId], ctx.snapshot)
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["apps", appId] })
      void qc.invalidateQueries({ queryKey: ["apps", appId, "builds"] })
      void qc.invalidateQueries({ queryKey: ["apps"] })
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["apps", appId] })
    },
  })
}

// ---------------------------------------------------------------------------
// useDeleteApp
// ---------------------------------------------------------------------------

export interface DeleteAppFlags {
  /** Wipe registry images + reclaim blobs. Default true. */
  deleteImages?: boolean
  /** Stop + force-remove Docker containers. Default true. */
  dockerCleanup?: boolean
  /** rm -rf the on-disk build workspace. Default true. */
  deleteBuildArtifacts?: boolean
  /** Remove the Caddy upstream/route. Default true. */
  deleteCaddyRoutes?: boolean
}

export function markAppDeletingInListCaches(
  qc: QueryClient,
  appId: string
): void {
  qc.setQueriesData<unknown>({ queryKey: ["apps"] }, (current: unknown) => {
    if (!isAppListCache(current)) return current
    return current.map((app) =>
      app.id === appId ? { ...app, status: "deleting" } : app
    )
  })
}

export function removeAppFromListCaches(
  qc: QueryClient,
  appId: string
): void {
  qc.setQueriesData<unknown>({ queryKey: ["apps"] }, (current: unknown) => {
    if (!isAppListCache(current)) return current
    return current.filter((app) => app.id !== appId)
  })
}

export function markAppStoppedInListCaches(
  qc: QueryClient,
  appId: string
): void {
  qc.setQueriesData<unknown>({ queryKey: ["apps"] }, (current: unknown) => {
    if (!isAppListCache(current)) return current
    return current.map((app) =>
      app.id === appId ? { ...app, status: "stopped" } : app
    )
  })
}

type AppListCacheSnapshot = Array<[QueryKey, Array<AppListItem>]>

function isAppListCache(value: unknown): value is Array<AppListItem> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { name?: unknown }).name === "string"
    )
  )
}

function snapshotAppListCaches(qc: QueryClient): AppListCacheSnapshot {
  return qc
    .getQueriesData<unknown>({ queryKey: ["apps"] })
    .filter(
      (entry): entry is [QueryKey, Array<AppListItem>] =>
        isAppListCache(entry[1])
    )
}

function restoreAppListCaches(
  qc: QueryClient,
  snapshot: AppListCacheSnapshot | undefined
): void {
  snapshot?.forEach(([queryKey, data]) => {
    qc.setQueryData(queryKey, data)
  })
}

export function useDeleteApp(appId: string) {
  const qc = useQueryClient()
  const trackDelete = useTrackAppDelete(appId)
  return useMutation<
    { ok: boolean; jobId: string; status: string },
    ApiError,
    DeleteAppFlags | void
  >({
    mutationFn: (flags) => {
      const params = new URLSearchParams()
      if (flags) {
        for (const [k, v] of Object.entries(flags)) {
          if (typeof v === "boolean") params.set(k, String(v))
        }
      }
      const qs = params.toString()
      return apiFetch<{ ok: boolean; jobId: string; status: string }>(
        `/apps/${appId}${qs ? `?${qs}` : ""}`,
        { method: "DELETE" }
      )
    },
    onMutate: () => {
      const listSnapshot = snapshotAppListCaches(qc)
      markAppDeletingInListCaches(qc, appId)
      toast.loading(i18n.t("apps:toasts.deleting"), {
        id: `delete-app:${appId}`,
      })
      return { listSnapshot }
    },
    onSuccess: (result) => {
      // Bust apiFetch's module-level GET cache for the apps list — without
      // this, the in-memory Promise from a previous /apps?organizationId=…
      // fetch is replayed and the deleted app reappears until hard refresh.
      // Note: the cascade is async on the server (job queue). Keep the app in
      // the list until the persisted job status or SSE confirms completion.
      trackDelete(result.jobId)
      invalidateGetCache()
      void qc.invalidateQueries({ queryKey: ["apps"] })
    },
    onError: (error, _vars, context) => {
      toast.dismiss(`delete-app:${appId}`)
      notifyMutationError(error, i18n.t("apps:toasts.deleteFailed"))
      const ctx = context as { listSnapshot?: AppListCacheSnapshot } | undefined
      restoreAppListCaches(qc, ctx?.listSnapshot)
      void qc.invalidateQueries({ queryKey: ["apps"] })
    },
  })
}

// ---------------------------------------------------------------------------
// usePruneRegistry
// ---------------------------------------------------------------------------

export interface GcResult {
  reposScanned: number
  tagsDeleted: number
  bytesFreed: number
}

export function usePruneRegistry(appId: string) {
  const qc = useQueryClient()
  return useMutation<GcResult, ApiError, void>({
    mutationFn: () =>
      apiFetch<GcResult>(`/apps/${appId}/registry-gc`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["apps", appId, "registry-usage"] })
      void qc.invalidateQueries({ queryKey: ["apps", appId, "builds"] })
    },
    onError: (error) => {
      notifyMutationError(error, i18n.t("apps:toasts.registryGcFailed"))
    },
  })
}

// ---------------------------------------------------------------------------
// useUpdateAppSettings
// ---------------------------------------------------------------------------

export function useUpdateAppSettings(appId: string) {
  const qc = useQueryClient()
  const trackRestart = useTrackAppRestart(appId)
  return useMutation<
    { app: AppDetail; restartTriggered: boolean },
    ApiError,
    AppSettingsPatch,
    { toastId: string }
  >({
    mutationFn: async (body) => {
      const { healthcheckPath, healthcheckPort, restartPolicy, ...rest } = body
      const payload: Record<string, unknown> = { ...rest }
      if (restartPolicy !== undefined) payload.restartPolicy = restartPolicy
      if (healthcheckPath !== undefined || healthcheckPort !== undefined) {
        const healthcheck: Record<string, unknown> = {}
        if (healthcheckPath !== undefined) healthcheck.path = healthcheckPath
        if (healthcheckPort !== undefined)
          healthcheck.port = healthcheckPort
        payload.healthcheck = healthcheck
      }
      const { app, restartTriggered } = await apiFetch<{
        app: RawAppDetail
        restartTriggered?: boolean
      }>(`/apps/${appId}`, { method: "PATCH", body: payload })
      return {
        app: normalizeAppDetail(app),
        restartTriggered: restartTriggered ?? false,
      }
    },
    onMutate: () => {
      const toastId = `app-settings-${appId}`
      toast.loading(i18n.t("apps:toasts.savingSettings"), { id: toastId })
      return { toastId }
    },
    onSuccess: ({ app, restartTriggered }, _vars, ctx) => {
      toast.success(i18n.t("apps:toasts.settingsSaved"), { id: ctx.toastId })
      qc.setQueryData<AppDetail | undefined>(["apps", appId], (previous) =>
        previous ? { ...previous, ...app } : app
      )
      void qc.invalidateQueries({ queryKey: ["apps"] })
      // The PATCH may have triggered a background restart (e.g. restartPolicy
      // changed on a running app). Show a separate toast that tracks the
      // restart progress via the next SSE deploy.status_change event.
      if (restartTriggered) trackRestart()
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.toastId) toast.dismiss(ctx.toastId)
      notifyMutationError(error, i18n.t("apps:toasts.settingsSaveFailed"))
    },
  })
}
