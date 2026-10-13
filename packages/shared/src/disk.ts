// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

// Host disk usage and reclaim: contract between the API and the web dashboard.
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
  inodesTotal: z.number().nonnegative().nullable().default(null),
  inodesUsed: z.number().nonnegative().nullable().default(null),
})
export type DiskHostUsage = z.infer<typeof DiskHostUsageSchema>

export const DiskUsageResponseSchema = z.object({
  categories: z.array(DiskUsageCategorySchema),
  layersSizeBytes: z.number().nonnegative(),
  // Root-filesystem usage from the agent's host stats; null if unavailable.
  host: DiskHostUsageSchema.nullable(),
  // Null until the first Docker measurement completes. An empty category list
  // during that window is pending data, not a measured zero.
  refreshedAt: z.string().datetime().nullable(),
  stale: z.boolean(),
  refreshFailed: z.boolean().default(false),
  cleanupReclaimableBytes: z.number().nonnegative().nullable().default(null),
  topConsumers: z
    .array(
      z.object({
        kind: DiskUsageCategoryKindEnum,
        name: z.string(),
        sizeBytes: z.number().nonnegative(),
      })
    )
    .default([]),
})
export type DiskUsageResponse = z.infer<typeof DiskUsageResponseSchema>

export const DiskSampleSchema = z.object({
  measuredAt: z.string().datetime(),
  usedBytes: z.number().nonnegative(),
  totalBytes: z.number().positive(),
})
export type DiskSample = z.infer<typeof DiskSampleSchema>
export const DiskInsightsResponseSchema = z.object({
  history: z.array(DiskSampleSchema),
  growth7dBytes: z.number().nullable(),
  daysTo90Percent: z.number().nonnegative().nullable(),
})
export type DiskInsightsResponse = z.infer<typeof DiskInsightsResponseSchema>

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
