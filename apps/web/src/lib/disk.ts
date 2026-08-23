// SPDX-License-Identifier: AGPL-3.0-only
import {
  DiskJobStatusSchema,
  DiskPruneResultSchema,
  DiskUsageResponseSchema,
} from "@ploydok/shared"
import { apiFetch } from "./api"
import type {
  DiskJobStatus,
  DiskPruneResult,
  DiskUsageResponse,
} from "@ploydok/shared"

// `refresh` forces the API to re-run the expensive `docker system df` walk
// instead of answering from its cache — used after a prune job completes.
export async function getDiskUsage(
  refresh = false
): Promise<DiskUsageResponse> {
  const data = await apiFetch<unknown>(
    refresh ? "/disk/usage?refresh=1" : "/disk/usage"
  )
  return DiskUsageResponseSchema.parse(data)
}

export async function pruneImages(): Promise<DiskPruneResult> {
  const data = await apiFetch<unknown>("/disk/prune/images", {
    method: "POST",
  })
  return DiskPruneResultSchema.parse(data)
}

export async function pruneBuildCache(): Promise<DiskPruneResult> {
  const data = await apiFetch<unknown>("/disk/prune/build-cache", {
    method: "POST",
  })
  return DiskPruneResultSchema.parse(data)
}

export async function cleanupDocker(): Promise<DiskPruneResult> {
  const data = await apiFetch<unknown>("/disk/cleanup", { method: "POST" })
  return DiskPruneResultSchema.parse(data)
}

export async function getDiskJob(jobId: string): Promise<DiskJobStatus> {
  const data = await apiFetch<unknown>(`/disk/jobs/${jobId}`)
  return DiskJobStatusSchema.parse(data)
}

export async function getDiskJobs(): Promise<DiskJobStatus[]> {
  const data = await apiFetch<unknown>("/disk/jobs")
  return DiskJobStatusSchema.array().parse(data)
}
