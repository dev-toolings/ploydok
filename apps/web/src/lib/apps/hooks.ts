// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch, criticalQueryDefaults, invalidateGetCache } from "../api"
import i18n from "../i18n"
import { useEventsSubscription } from "../events-provider"
import {
  applyAppStatus,
  getEventAppStatus,
  normalizeAppDetail,
  normalizeAppListItem,
} from "./transforms"
import type { ApiError } from "../api"
import type {
  AppConfig,
  Build,
  BuildStatus,
  CaddyExtraHandlers,
  CdnConfig,
  CloudflareManagedCdn,
  CloudflareManagedCdnStatus,
} from "@ploydok/shared"
import type {
  AppDetail,
  AppListItem,
  AppStatusEventPayload,
  AppsResponse,
  BuildStatusEventPayload,
  BuildsResponse,
  RawAppDetail,
  RegistryUsage,
  UseAppOptions,
  UseBuildsOptions,
} from "./types"

export function useApps(organizationId?: string) {
  const qc = useQueryClient()

  // Live-patch the matching row on every status-bearing event. setQueriesData
  // matches all ["apps", *] caches by prefix — covers ["apps", "all"] and the
  // per-org caches. Without this, the list freezes until next refetch.
  const patchAppStatus = React.useCallback(
    (appId: string, status: import("@ploydok/shared").AppStatus) => {
      qc.setQueriesData<Array<AppListItem>>(
        { queryKey: ["apps"] },
        (current) => {
          if (!Array.isArray(current)) return current
          let changed = false
          const next = current.map((app) => {
            if (app.id !== appId) return app
            const patched = applyAppStatus(app, status) as AppListItem
            if (patched !== app) changed = true
            return patched
          })
          return changed ? next : current
        }
      )
    },
    [qc]
  )

  // For unknown appIds (a brand-new app spinning up while the user sits on
  // the list) — refetch once so the new row appears without a manual reload.
  const refetchListIfMissing = React.useCallback(
    (appId: string) => {
      const caches = qc.getQueriesData<Array<AppListItem>>({
        queryKey: ["apps"],
      })
      const known = caches.some(
        ([, data]) => Array.isArray(data) && data.some((a) => a.id === appId)
      )
      if (!known) {
        invalidateGetCache()
        void qc.invalidateQueries({ queryKey: ["apps"] })
      }
    },
    [qc]
  )

  useEventsSubscription<AppStatusEventPayload>("build.started", (payload) => {
    if (!payload.appId) return
    const status = getEventAppStatus(payload) ?? "building"
    patchAppStatus(payload.appId, status)
    refetchListIfMissing(payload.appId)
  })

  useEventsSubscription<AppStatusEventPayload>("build.succeeded", (payload) => {
    if (!payload.appId) return
    // Final status arrives via deploy.status_change; until then keep the row
    // in "running"-ish state by trusting the event payload if present.
    const status = getEventAppStatus(payload)
    if (status) patchAppStatus(payload.appId, status)
    invalidateGetCache()
    void qc.invalidateQueries({ queryKey: ["apps"] })
  })

  useEventsSubscription<AppStatusEventPayload>("build.failed", (payload) => {
    if (!payload.appId) return
    const status = getEventAppStatus(payload) ?? "failed"
    patchAppStatus(payload.appId, status)
  })

  useEventsSubscription<AppStatusEventPayload>(
    "deploy.status_change",
    (payload) => {
      if (!payload.appId) return
      const status = getEventAppStatus(payload)
      if (status) patchAppStatus(payload.appId, status)
      // On terminal transitions (running/failed) re-fetch to pick up
      // domain/branch/repo changes the worker may have updated alongside.
      if (status === "running" || status === "failed") {
        invalidateGetCache()
        void qc.invalidateQueries({ queryKey: ["apps"] })
      }
    }
  )

  return useQuery<Array<AppListItem>, ApiError>({
    queryKey: ["apps", organizationId ?? "all"],
    queryFn: async () => {
      const query = organizationId
        ? `?organizationId=${encodeURIComponent(organizationId)}`
        : ""
      const data = await apiFetch<AppsResponse>(`/apps${query}`)
      return data.apps.map(normalizeAppListItem)
    },
    staleTime: 30_000,
    ...criticalQueryDefaults,
  })
}

export function useCreateApp() {
  const qc = useQueryClient()
  return useMutation<AppListItem, ApiError, Partial<AppConfig>>({
    mutationFn: (body) =>
      apiFetch<AppListItem>("/apps", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      }),
    onSuccess: (_, vars) => {
      toast.success(i18n.t("apps:toasts.created"))
      // The new app's auto-deploy emits build.started immediately — but the
      // GET cache from a prior /apps?organizationId=… read would replay
      // stale data and hide the new row until hard refresh. Same fix as
      // useDeleteApp: bust the module-level cache before invalidating RQ.
      invalidateGetCache()
      qc.invalidateQueries({ queryKey: ["apps"] })
      if (vars.organizationId ?? vars.projectId) {
        qc.invalidateQueries({
          queryKey: ["apps", vars.organizationId ?? vars.projectId],
        })
      }
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })
}

export function useApp(appId: string, opts?: UseAppOptions) {
  const qc = useQueryClient()
  const subscribeToEvents = opts?.subscribeToEvents ?? true

  const syncStatus = (status: import("@ploydok/shared").AppStatus) => {
    qc.setQueryData<AppDetail | undefined>(["apps", appId], (current) =>
      applyAppStatus(current, status)
    )
    // Match every list cache by prefix — ["apps", "all"], ["apps", orgId], …
    // Plain setQueryData(["apps"], …) only hit the literal ["apps"] key,
    // which never exists in practice, so the list never updated.
    qc.setQueriesData<Array<AppListItem>>({ queryKey: ["apps"] }, (current) => {
      if (!Array.isArray(current)) return current
      let changed = false
      const next = current.map((app) => {
        if (app.id !== appId) return app
        const patched = applyAppStatus(app, status) as AppListItem
        if (patched !== app) changed = true
        return patched
      })
      return changed ? next : current
    })
  }

  const refetchApp = () => {
    invalidateGetCache(`/apps/${appId}`)
    void qc.invalidateQueries({ queryKey: ["apps", appId] })
    void qc.invalidateQueries({ queryKey: ["apps"] })
  }

  useEventsSubscription<AppStatusEventPayload>(
    "build.started",
    (payload) => {
      if (payload.appId !== appId) return
      const status = getEventAppStatus(payload) ?? "building"
      syncStatus(status)
    },
    subscribeToEvents
  )

  useEventsSubscription<AppStatusEventPayload>(
    "deploy.status_change",
    (payload) => {
      if (payload.appId !== appId) return
      const status = getEventAppStatus(payload)
      if (status) syncStatus(status)
      refetchApp()
    },
    subscribeToEvents
  )

  useEventsSubscription<AppStatusEventPayload>(
    "build.failed",
    (payload) => {
      if (payload.appId !== appId) return
      refetchApp()
    },
    subscribeToEvents
  )

  useEventsSubscription<AppStatusEventPayload>(
    "build.succeeded",
    (payload) => {
      if (payload.appId !== appId) return
      refetchApp()
    },
    subscribeToEvents
  )

  return useQuery<AppDetail, ApiError>({
    queryKey: ["apps", appId],
    queryFn: async () => {
      const { app, builds: rawBuilds } = await apiFetch<{
        app: RawAppDetail
        builds: Array<Build>
      }>(`/apps/${appId}`)
      const normalized = normalizeAppDetail(app)
      const currentBuild = rawBuilds.find(
        (build) =>
          (build.status === "succeeded" ||
            build.status === "succeeded_with_warning") &&
          build.commitSha
      )
      // Attach builds[] returned by the endpoint so consumers can derive the
      // last build without a separate /builds request.
      return {
        ...normalized,
        currentCommitSha:
          normalized.currentCommitSha ?? currentBuild?.commitSha,
        latestBuildId: normalized.latestBuildId ?? rawBuilds[0]?.id,
        builds: rawBuilds,
      }
    },
    staleTime: 15_000,
    enabled: Boolean(appId),
    ...criticalQueryDefaults,
    ...(opts?.initialData !== undefined
      ? { initialData: opts.initialData }
      : {}),
  })
}

export function useBuilds(appId: string, opts?: UseBuildsOptions) {
  const qc = useQueryClient()

  const syncFromServer = React.useCallback(async () => {
    try {
      // Bust apiFetch's module-level GET cache before fetching — without this
      // we'd get the first response's cached Promise for the whole session.
      invalidateGetCache(`/apps/${appId}/builds`)
      invalidateGetCache(`/apps/${appId}`)
      const data = await apiFetch<BuildsResponse>(`/apps/${appId}/builds`)
      qc.setQueryData(["apps", appId, "builds"], data.builds)
    } catch {
      // A transient network error is fine — the next event/poll will retry.
    }
  }, [appId, qc])

  // When a build-related event arrives, fetch the fresh list and push it
  // straight into the cache with setQueryData. qc.refetchQueries /
  // invalidateQueries proved unreliable here — both no-op when RQ considers
  // the query "fresh" and when multiple refetches are batched within a few
  // ms (replay). We first patch the cache from the event payload for immediate
  // UI feedback, then fetch the canonical server row.
  const handleBuildEvent = React.useCallback(
    (type: BuildSseEventType) => (payload?: BuildStatusEventPayload) => {
      if (payload?.appId !== appId) return
      qc.setQueryData<Array<Build> | undefined>(
        ["apps", appId, "builds"],
        (current) => patchBuildsWithSseEvent(current, type, payload)
      )
      void syncFromServer()
    },
    [appId, qc, syncFromServer]
  )

  useEventsSubscription<BuildStatusEventPayload>(
    "build.started",
    handleBuildEvent("build.started")
  )
  useEventsSubscription<BuildStatusEventPayload>(
    "build.succeeded",
    handleBuildEvent("build.succeeded")
  )
  useEventsSubscription<BuildStatusEventPayload>(
    "build.failed",
    handleBuildEvent("build.failed")
  )
  useEventsSubscription<BuildStatusEventPayload>(
    "build.cancelled",
    handleBuildEvent("build.cancelled")
  )
  useEventsSubscription<BuildStatusEventPayload>(
    "deploy.status_change",
    handleBuildEvent("deploy.status_change")
  )

  return useQuery<Array<Build>, ApiError>({
    queryKey: ["apps", appId, "builds"],
    queryFn: async () => {
      const data = await apiFetch<BuildsResponse>(`/apps/${appId}/builds`)
      return data.builds
    },
    staleTime: 10_000,
    enabled: Boolean(appId),
    refetchInterval: (query) =>
      hasActiveBuilds(query.state.data) ? 3_000 : false,
    ...(opts?.initialData !== undefined
      ? { initialData: opts.initialData }
      : {}),
  })
}

export type BuildSseEventType =
  | "build.started"
  | "build.succeeded"
  | "build.failed"
  | "build.cancelled"
  | "deploy.status_change"

const TERMINAL_BUILD_STATUSES: ReadonlySet<BuildStatus> = new Set([
  "succeeded",
  "succeeded_with_warning",
  "failed",
  "cancelled",
])

function statusForBuildEvent(
  type: BuildSseEventType,
  payload: BuildStatusEventPayload
): BuildStatus | null {
  if (type === "build.started") return "running"
  if (type === "build.succeeded") return "succeeded"
  if (type === "build.failed") return "failed"
  if (type === "build.cancelled") return "cancelled"
  const status = payload.data?.status
  return status === "building" ? "running" : null
}

export function hasActiveBuilds(builds?: Array<Build>): boolean {
  return Boolean(
    builds?.some(
      (build) => build.status === "pending" || build.status === "running"
    )
  )
}

export function patchBuildsWithSseEvent(
  current: Array<Build> | undefined,
  type: BuildSseEventType,
  payload: BuildStatusEventPayload,
  now = Date.now()
): Array<Build> | undefined {
  if (!payload.buildId || !payload.appId) return current

  const nextStatus = statusForBuildEvent(type, payload)
  const source = current ?? []
  const existingIndex = source.findIndex(
    (build) => build.id === payload.buildId
  )
  const eventTime = typeof payload.t === "number" ? payload.t : now

  const patch = (build: Build): Build => {
    const next: Build = { ...build }
    if (nextStatus) next.status = nextStatus
    if (payload.data?.imageTag) next.imageTag = payload.data.imageTag
    if (payload.data?.containerId) next.containerId = payload.data.containerId
    if (type === "build.started" && !next.startedAt) next.startedAt = eventTime
    if (nextStatus && TERMINAL_BUILD_STATUSES.has(nextStatus)) {
      if (!next.finishedAt) next.finishedAt = eventTime
      if (payload.message && type === "build.failed") {
        next.errorMessage = payload.data?.errorMessage ?? payload.message
      }
    }
    return next
  }

  if (existingIndex === -1) {
    if (type !== "build.started") return current
    const synthetic: Build = {
      id: payload.buildId,
      appId: payload.appId,
      status: "running",
      startedAt: eventTime,
      createdAt: eventTime,
    }
    return [synthetic, ...source]
  }

  const next = [...source]
  next[existingIndex] = patch(next[existingIndex])
  return next
}

export function useRegistryUsage(appId: string) {
  return useQuery<RegistryUsage, ApiError>({
    queryKey: ["apps", appId, "registry-usage"],
    queryFn: () => apiFetch<RegistryUsage>(`/apps/${appId}/registry-usage`),
    staleTime: 30_000,
    enabled: Boolean(appId),
  })
}

export function useAppCaddyExtra(appId: string) {
  return useQuery<{ handlers: CaddyExtraHandlers | null }, ApiError>({
    queryKey: ["apps", appId, "caddy-extra"],
    queryFn: () =>
      apiFetch<{ handlers: CaddyExtraHandlers | null }>(
        `/apps/${appId}/caddy-extra`
      ),
    staleTime: 15_000,
    enabled: Boolean(appId),
  })
}

export function useUpdateAppCaddyExtra() {
  const qc = useQueryClient()
  return useMutation<
    { handlers: CaddyExtraHandlers | null },
    ApiError,
    { appId: string; handlers: CaddyExtraHandlers | null }
  >({
    mutationFn: ({ appId, handlers }) =>
      apiFetch<{ handlers: CaddyExtraHandlers | null }>(
        `/apps/${appId}/caddy-extra`,
        {
          method: "PATCH",
          body: { handlers },
          headers: { "content-type": "application/json" },
        }
      ),
    onSuccess: (data, { appId }) => {
      toast.success(i18n.t("apps:toasts.caddyUpdated"))
      qc.setQueryData(["apps", appId, "caddy-extra"], data)
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })
}

export type AppCdnConfig = CdnConfig & {
  ready?: boolean
  warning?: string
}

export function useAppCdn(appId: string) {
  return useQuery<AppCdnConfig, ApiError>({
    queryKey: ["apps", appId, "cdn"],
    queryFn: () => apiFetch<AppCdnConfig>(`/apps/${appId}/cdn`),
    staleTime: 15_000,
    enabled: Boolean(appId),
  })
}

export function useUpdateAppCdn() {
  const qc = useQueryClient()
  return useMutation<
    AppCdnConfig,
    ApiError,
    { appId: string; config: CdnConfig }
  >({
    mutationFn: ({ appId, config }) =>
      apiFetch<AppCdnConfig>(`/apps/${appId}/cdn`, {
        method: "PUT",
        body: config,
        headers: { "content-type": "application/json" },
      }),
    onSuccess: (data, { appId }) => {
      if (data.ready === false) {
        toast.warning(i18n.t("apps:toasts.cdnSavedPending"))
      } else {
        toast.success(i18n.t("apps:toasts.cdnUpdated"))
      }
      qc.setQueryData(["apps", appId, "cdn"], data)
      invalidateGetCache(`/apps/${appId}`)
      void qc.invalidateQueries({ queryKey: ["apps", appId] })
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })
}

export function useAppCloudflareCdn(appId: string) {
  return useQuery<CloudflareManagedCdnStatus, ApiError>({
    queryKey: ["apps", appId, "cdn", "cloudflare"],
    queryFn: () =>
      apiFetch<CloudflareManagedCdnStatus>(`/apps/${appId}/cdn/cloudflare`),
    staleTime: 15_000,
    enabled: Boolean(appId),
  })
}

export function useUpdateAppCloudflareCdn() {
  const qc = useQueryClient()
  return useMutation<
    AppCdnConfig & { cloudflare: CloudflareManagedCdnStatus },
    ApiError,
    { appId: string; config: CloudflareManagedCdn }
  >({
    mutationFn: ({ appId, config }) =>
      apiFetch<AppCdnConfig & { cloudflare: CloudflareManagedCdnStatus }>(
        `/apps/${appId}/cdn/cloudflare`,
        {
          method: "PUT",
          body: config,
          headers: { "content-type": "application/json" },
        }
      ),
    onSuccess: (data, { appId }) => {
      if (data.cloudflare.status === "failed") {
        toast.warning(i18n.t("apps:toasts.cloudflareSavedFailed"))
      } else {
        toast.success(i18n.t("apps:toasts.cloudflareConfigured"))
      }
      qc.setQueryData(["apps", appId, "cdn"], data)
      qc.setQueryData(["apps", appId, "cdn", "cloudflare"], data.cloudflare)
      invalidateGetCache(`/apps/${appId}`)
      void qc.invalidateQueries({ queryKey: ["apps", appId] })
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })
}

export function usePurgeAppCloudflareCdn(appId: string) {
  return useMutation<{ ok: true }, ApiError, void>({
    mutationFn: () =>
      apiFetch<{ ok: true }>(`/apps/${appId}/cdn/cloudflare/purge`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success(i18n.t("apps:toasts.cachePurgeRequested"))
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })
}
