// SPDX-License-Identifier: AGPL-3.0-only
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { apiFetch } from "./api"
import type { ApiError } from "./api"
import type {
  DeploymentActivityRange,
  OrganizationDeployment,
  OrganizationDeploymentActivityResponse,
  OrganizationDeploymentsResponse,
} from "@ploydok/shared"

const DAY_MS = 86_400_000

// Rows sampled per window to estimate the median build time. The API caps a
// page at 100, which is plenty for a median.
const DURATION_SAMPLE = 100

export interface DeploymentWindow {
  total: number
  succeeded: number
  failed: number
  /** Median build duration in ms, null when no finished build has timings. */
  medianDurationMs: number | null
}

export interface WindowComparison {
  current: DeploymentWindow
  previous: DeploymentWindow
}

// Activity, windows and the dashboard table all live under the deployments
// prefix, so build events refresh them with the rest of the deployment caches.
export function useDeploymentActivity(
  orgSlug: string,
  days: DeploymentActivityRange
) {
  return useQuery<OrganizationDeploymentActivityResponse, ApiError>({
    queryKey: ["organizations", orgSlug, "deployments", "activity", days],
    queryFn: () =>
      apiFetch<OrganizationDeploymentActivityResponse>(
        `/organizations/${encodeURIComponent(orgSlug)}/deployments/activity?days=${days}`
      ),
    enabled: Boolean(orgSlug),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}

/** Compares the last `days` days with the `days` days before them. */
export function useDeploymentWindows(orgSlug: string, days: number) {
  return useQuery<WindowComparison, ApiError>({
    queryKey: ["organizations", orgSlug, "deployments", "windows", days],
    queryFn: async () => {
      const now = Date.now()
      const [current, previous] = await Promise.all([
        fetchWindow(orgSlug, now - days * DAY_MS, now),
        fetchWindow(orgSlug, now - 2 * days * DAY_MS, now - days * DAY_MS),
      ])
      return { current, previous }
    },
    enabled: Boolean(orgSlug),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}

async function fetchWindow(
  orgSlug: string,
  from: number,
  to: number
): Promise<DeploymentWindow> {
  const params = new URLSearchParams({
    page: "1",
    pageSize: String(DURATION_SAMPLE),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  })
  const response = await apiFetch<OrganizationDeploymentsResponse>(
    `/organizations/${encodeURIComponent(orgSlug)}/deployments?${params}`
  )
  const { summary } = response
  return {
    total: summary.total,
    succeeded: summary.succeeded + summary.succeededWithWarning,
    failed: summary.failed,
    medianDurationMs: medianDuration(response.deployments),
  }
}

export function medianDuration(
  deployments: ReadonlyArray<OrganizationDeployment>
): number | null {
  const durations = deployments
    .filter(
      (deployment) =>
        deployment.startedAt !== undefined &&
        deployment.finishedAt !== undefined &&
        deployment.finishedAt >= deployment.startedAt
    )
    .map((deployment) => deployment.finishedAt! - deployment.startedAt!)
    .sort((a, b) => a - b)
  if (durations.length === 0) return null
  const middle = Math.floor(durations.length / 2)
  return durations.length % 2 === 1
    ? durations[middle]
    : Math.round((durations[middle - 1] + durations[middle]) / 2)
}

/** Success rate in percent over finished builds, null without any. */
export function successRate(window: DeploymentWindow): number | null {
  const finished = window.succeeded + window.failed
  return finished === 0 ? null : (window.succeeded / finished) * 100
}

/** Relative change in percent, null when there is no baseline. */
export function relativeChange(
  current: number | null,
  previous: number | null
): number | null {
  if (current === null || previous === null || previous === 0) return null
  return ((current - previous) / previous) * 100
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, "0")}`
}
