// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

// Host disk usage & reclaim — contract between the API and the web dashboard.
// Backs the "Disk" panel: a `docker system df` breakdown plus host filesystem
// usage, and on-demand prune jobs (image / build-cache).

export const DiskUsageCategoryKindEnum = z.enum([
  "images",
  "containers",
  "volumes",
  "build_cache",
])
export type DiskUsageCategoryKind = z.infer<typeof DiskUsageCategoryKindEnum>

export const DiskUsageCategorySchema = z.object({
  kind: DiskUsageCategoryKindEnum,
  totalBytes: z.number().nonnegative(),
  reclaimableBytes: z.number().nonnegative(),
  count: z.number().int().nonnegative(),
})
export type DiskUsageCategory = z.infer<typeof DiskUsageCategorySchema>

export const DiskHostUsageSchema = z.object({
  totalBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
})
export type DiskHostUsage = z.infer<typeof DiskHostUsageSchema>

export const DiskUsageResponseSchema = z.object({
  categories: z.array(DiskUsageCategorySchema),
  layersSizeBytes: z.number().nonnegative(),
  // Root-filesystem usage from the agent's host stats; null if unavailable.
  host: DiskHostUsageSchema.nullable(),
  // When the breakdown was measured. `docker system df` is expensive, so the
  // API serves it from a stale-while-revalidate cache: `stale` means a
  // background refresh is running and these numbers are the previous ones.
  refreshedAt: z.string(),
  stale: z.boolean(),
})
export type DiskUsageResponse = z.infer<typeof DiskUsageResponseSchema>

// Prune endpoints enqueue a system_jobs row and return its id; the caller
// re-fetches the usage breakdown once the job completes.
export const DiskPruneResultSchema = z.object({
  jobId: z.string(),
})
export type DiskPruneResult = z.infer<typeof DiskPruneResultSchema>

export const DiskJobResultSchema = z.union([
  z.object({ skipped: z.string() }),
  z.object({
    imagesDeleted: z.number().int().nonnegative(),
    spaceReclaimedBytes: z.number().nonnegative(),
  }),
  z.object({ output: z.string() }),
  z.object({
    stoppedContainersDeleted: z.number().int().nonnegative(),
    unusedImagesDeleted: z.number().int().nonnegative(),
    imagesSpaceReclaimedBytes: z.number().nonnegative(),
    builderCacheSpaceReclaimedBytes: z.number().nonnegative(),
    unusedNetworksDeleted: z.number().int().nonnegative(),
    localCacheDirsRemoved: z.number().int().nonnegative(),
    localCacheSpaceReclaimedBytes: z.number().nonnegative(),
    dedicatedBuildKitOutput: z.string(),
  }),
  z.object({
    activeBuildAppsSkipped: z.number().int().nonnegative(),
    docker: z.record(z.string(), z.unknown()),
    localCaches: z.record(z.string(), z.unknown()),
    dedicatedBuildKit: z.record(z.string(), z.unknown()),
  }),
])
export type DiskJobResult = z.infer<typeof DiskJobResultSchema>

export const DiskJobStatusSchema = z.object({
  jobId: z.string(),
  kind: z.enum(["gc.images", "gc.buildcache", "gc.docker"]),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  result: DiskJobResultSchema.nullable(),
  errorMessage: z.string().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type DiskJobStatus = z.infer<typeof DiskJobStatusSchema>
