// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch, invalidateGetCache } from "./api"
import { useEventsSubscription } from "./events-provider"
import { notifyMutationError } from "./second-factor-toast"
import i18n from "./i18n"
import type { ApiError } from "./api"
import type {
  BuildStatus,
  OrganizationDeployment,
  OrganizationDeploymentApp,
  OrganizationDeploymentsResponse,
} from "@ploydok/shared"

export type WorkspaceDeploymentApplication = OrganizationDeploymentApp
export type WorkspaceDeployment = OrganizationDeployment

export interface WorkspaceDeploymentFilters {
  page: number
  pageSize: number
  appId?: string
  status?: BuildStatus
  source?: string
  q?: string
  from?: string
  to?: string
}

export type WorkspaceDeploymentsPagination =
  OrganizationDeploymentsResponse["pagination"]
export type WorkspaceDeploymentsSummary =
  OrganizationDeploymentsResponse["summary"]

export type WorkspaceDeploymentsResponse = OrganizationDeploymentsResponse

const BUILD_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "succeeded",
  "succeeded_with_warning",
  "failed",
  "cancelled",
])

const DEPLOYMENT_SOURCES: ReadonlySet<string> = new Set([
  "api",
  "webhook:github",
  "webhook:gitlab",
  "cron:gc",
  "cron:cleanup",
  "auto:push",
  "auto:tag",
  "system",
])

export const DEFAULT_WORKSPACE_DEPLOYMENT_FILTERS: WorkspaceDeploymentFilters =
  {
    page: 1,
    pageSize: 20,
  }

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" && typeof value !== "string") return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function validDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return undefined
  if (value.includes("T") && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return undefined
  }
  return Number.isNaN(Date.parse(value)) ? undefined : value
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function boundedQuery(value: unknown): string | undefined {
  const normalized = nonEmptyString(value)
  return normalized ? normalized.slice(0, 250) : undefined
}

export function normalizeWorkspaceDeploymentFilters(
  search: Record<string, unknown>
): WorkspaceDeploymentFilters {
  const status = nonEmptyString(search["status"])
  const from = validDate(search["from"])
  const to = validDate(search["to"])
  const fromTime = from ? Date.parse(from) : undefined
  const toTime = to ? Date.parse(to) : undefined
  const rangeIsReversed =
    fromTime !== undefined &&
    toTime !== undefined &&
    Number.isFinite(fromTime) &&
    Number.isFinite(toTime) &&
    fromTime > toTime
  return {
    page: positiveInteger(search["page"], 1),
    pageSize: Math.min(100, positiveInteger(search["pageSize"], 20)),
    appId: nonEmptyString(search["appId"]),
    status: BUILD_STATUSES.has(status ?? "")
      ? (status as BuildStatus)
      : undefined,
    source: DEPLOYMENT_SOURCES.has(nonEmptyString(search["source"]) ?? "")
      ? nonEmptyString(search["source"])
      : undefined,
    q: boundedQuery(search["q"]),
    from: rangeIsReversed ? to : from,
    to: rangeIsReversed ? from : to,
  }
}

export function workspaceDeploymentsQueryKey(
  orgSlug: string,
  filters: WorkspaceDeploymentFilters
): readonly [
  "organizations",
  string,
  "deployments",
  WorkspaceDeploymentFilters,
] {
  return ["organizations", orgSlug, "deployments", filters]
}

export function workspaceDeploymentsPath(
  orgSlug: string,
  filters: WorkspaceDeploymentFilters
): string {
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  })
  for (const [key, value] of Object.entries(filters)) {
    if (key === "page" || key === "pageSize" || value === undefined) continue
    const normalizedValue =
      key === "from" || key === "to"
        ? normalizeDateForApi(String(value), key === "to")
        : String(value)
    params.set(key, normalizedValue)
  }
  return `/organizations/${encodeURIComponent(orgSlug)}/deployments?${params}`
}

function normalizeDateForApi(value: string, endOfDay: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
}

function hasActiveDeployments(
  deployments?: Array<WorkspaceDeployment>
): boolean {
  return Boolean(
    deployments?.some(
      (deployment) =>
        deployment.status === "pending" || deployment.status === "running"
    )
  )
}

function invalidateWorkspaceDeploymentCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  orgSlug: string,
  appId: string
): void {
  invalidateGetCache()
  void queryClient.invalidateQueries({
    queryKey: ["organizations", orgSlug, "deployments"],
  })
  void queryClient.invalidateQueries({ queryKey: ["apps", appId] })
  void queryClient.invalidateQueries({ queryKey: ["apps", appId, "builds"] })
}

export function useWorkspaceDeployments(
  orgSlug: string,
  filters: WorkspaceDeploymentFilters,
  organizationAppIds?: ReadonlyArray<string>
) {
  const queryClient = useQueryClient()
  const queryKey = workspaceDeploymentsQueryKey(orgSlug, filters)
  const organizationApps = React.useMemo(
    () => (organizationAppIds ? new Set(organizationAppIds) : null),
    [organizationAppIds]
  )

  const refreshFromEvent = React.useCallback(
    (event: { appId?: string }) => {
      if (
        organizationApps &&
        (!event.appId || !organizationApps.has(event.appId))
      ) {
        return
      }
      invalidateGetCache()
      void queryClient.invalidateQueries({
        queryKey: ["organizations", orgSlug, "deployments"],
      })
    },
    [organizationApps, orgSlug, queryClient]
  )

  useEventsSubscription("build.started", refreshFromEvent)
  useEventsSubscription("build.succeeded", refreshFromEvent)
  useEventsSubscription("build.failed", refreshFromEvent)
  useEventsSubscription("build.cancelled", refreshFromEvent)

  return useQuery<WorkspaceDeploymentsResponse, ApiError>({
    queryKey,
    queryFn: () =>
      apiFetch<WorkspaceDeploymentsResponse>(
        workspaceDeploymentsPath(orgSlug, filters)
      ),
    enabled: Boolean(orgSlug),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      hasActiveDeployments(query.state.data?.deployments) ? 3_000 : 30_000,
  })
}

export function useWorkspaceDeploymentActions(orgSlug: string) {
  const queryClient = useQueryClient()
  const invalidate = React.useCallback(
    (appId: string) =>
      invalidateWorkspaceDeploymentCaches(queryClient, orgSlug, appId),
    [orgSlug, queryClient]
  )

  const cancel = useMutation<
    { ok: boolean },
    ApiError,
    { appId: string; buildId: string }
  >({
    mutationFn: ({ appId, buildId }) =>
      apiFetch<{ ok: boolean }>(`/apps/${appId}/builds/${buildId}/cancel`, {
        method: "POST",
      }),
    onSuccess: (_result, { appId }) => {
      toast.success(i18n.t("workspace:deployments.cancelledToast"))
      invalidate(appId)
    },
    onError: (error) =>
      notifyMutationError(error, i18n.t("workspace:deployments.cancelFailed")),
  })

  const rollback = useMutation<
    { ok: boolean },
    ApiError,
    { appId: string; buildId: string }
  >({
    mutationFn: ({ appId, buildId }) =>
      apiFetch<{ ok: boolean }>(`/apps/${appId}/rollback`, {
        method: "POST",
        body: { buildId },
      }),
    onSuccess: (_result, { appId }) => {
      toast.success(i18n.t("workspace:deployments.rollbackStarted"))
      invalidate(appId)
    },
    onError: (error) =>
      notifyMutationError(error, i18n.t("workspace:deployments.rollbackFailed")),
  })

  return { cancel, rollback }
}
