// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Daily Docker cleanup. The agent owns the fixed host Docker policy; this
 * handler additionally reclaims Ploydok's dedicated BuildKit and local caches.
 * Every sub-step is retained in `system_jobs.result`, and the first failure is
 * persisted then rethrown for BullMQ rather than being hidden.
 */
import { eq, inArray } from "drizzle-orm"
import { builds, createRedis, system_jobs } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { getSharedAgent } from "../../debug/singletons"
import { claimQueuedRow } from "../queue-claim"
import { auditClaimed, auditUnauthorized } from "../queue-audit"
import { cleanupBuildCaches, pruneBuildKitCache } from "../jobs/cleanup-build-caches"
import { env } from "../../env"
import { acquireGate } from "../build-cleanup-gate"

/** Gate TTL is 60s; renew at 20s to leave two full retries of margin. */
export const DOCKER_CLEANUP_GATE_TTL_MS = 60_000
export const DOCKER_CLEANUP_GATE_HEARTBEAT_MS = 20_000

export async function persistDockerCleanupProgress(
  db: Db,
  jobId: string,
  result: Record<string, unknown>
): Promise<void> {
  await db.update(system_jobs).set({ result }).where(eq(system_jobs.id, jobId))
}

interface DockerCleanupPayload {
  id?: string
  data: unknown
}

export async function handleDockerCleanupJob(
  db: Db,
  job: DockerCleanupPayload
): Promise<void> {
  const { jobId } = job.data as { jobId?: string }
  if (!jobId) {
    auditUnauthorized({
      jobName: "gc.docker.requested",
      jobId: job.id ?? "",
      payload: job.data,
      reason: "legacy payload (no jobId) — drop after queue drain",
    })
    return
  }
  const claimed = await claimQueuedRow<typeof system_jobs.$inferSelect>({
    db,
    table: system_jobs,
    id: jobId,
  })
  if (!claimed) {
    auditUnauthorized({
      jobName: "gc.docker.requested",
      jobId: job.id ?? "",
      payload: job.data,
      reason: "no matching pending system_jobs row (already running or completed)",
    })
    return
  }
  auditClaimed({
    jobName: "gc.docker.requested",
    jobId: job.id ?? "",
    rowId: jobId,
    actor: claimed.requested_by_user_id,
    source: claimed.source,
  })

  const lock = await acquireGate(createRedis(env.REDIS_URL), "writer")
  if (!lock) {
    await db
      .update(system_jobs)
      .set({
        status: "cancelled",
        finished_at: new Date(),
        result: { skipped: "another Docker cleanup is running" },
      })
      .where(eq(system_jobs.id, jobId))
    return
  }

  let leaseLost = false
  const heartbeat = setInterval(() => {
    void lock.renew().then((owned) => { if (!owned) leaseLost = true })
  }, DOCKER_CLEANUP_GATE_HEARTBEAT_MS)
  const fence = async () => {
    if (leaseLost || !(await lock.renew())) {
      leaseLost = true
      throw new Error("Docker cleanup lease lost")
    }
  }

  try {
    const activeBuildRows = await db
      .select({ app_id: builds.app_id })
      .from(builds)
      .where(inArray(builds.status, ["pending", "running"]))
    const activeAppIds = new Set(activeBuildRows.map((row) => row.app_id))
    const result: Record<string, unknown> = {
      activeBuildAppsSkipped: activeAppIds.size,
      docker: { status: activeAppIds.size ? "skipped_active_builds" : "pending" },
      localCaches: { status: activeAppIds.size ? "skipped_active_builds" : "pending" },
      dedicatedBuildKit: { status: activeAppIds.size ? "skipped_active_builds" : "pending" },
    }
    const persist = async () => {
      await persistDockerCleanupProgress(db, jobId, result)
    }
    await persist()
    // A running build may be reading its local cache or BuildKit metadata.
    // Skip *all* destructive cache pruning for this pass; next scheduled run
    // resumes once the durable build state is idle.
    if (activeAppIds.size > 0) {
      await db
        .update(system_jobs)
        .set({ status: "succeeded", finished_at: new Date(), result })
        .where(eq(system_jobs.id, jobId))
      return
    }
    await fence()
    const docker = await getSharedAgent().dockerCleanup({})
    result.docker = {
      status: "succeeded",
      stoppedContainersDeleted: docker.stoppedContainersDeleted,
      unusedImagesDeleted: docker.unusedImagesDeleted,
      imagesSpaceReclaimedBytes: docker.imagesSpaceReclaimedBytes,
      builderCacheSpaceReclaimedBytes: docker.builderCacheSpaceReclaimedBytes,
      unusedNetworksDeleted: docker.unusedNetworksDeleted,
    }
    await persist()
    await fence()
    const local = await cleanupBuildCaches({ activeAppIds })
    result.localCaches = {
      status: "succeeded",
      removedDirs: local.removedDirs,
      removedBytes: local.removedBytes,
      skippedActiveApps: local.skippedActiveApps,
    }
    await persist()
    await fence()
    const dedicated = await pruneBuildKitCache()
    if (!dedicated.ok) {
      result.dedicatedBuildKit = { status: "failed", error: dedicated.error ?? "unknown" }
      await persist()
      throw new Error(dedicated.error ?? "dedicated BuildKit cleanup failed")
    }
    result.dedicatedBuildKit = { status: "succeeded", output: (dedicated.output ?? "").slice(0, 10_000) }
    await db
      .update(system_jobs)
      .set({
        status: "succeeded",
        finished_at: new Date(),
        result,
      })
      .where(eq(system_jobs.id, jobId))
  } catch (err) {
    await db
      .update(system_jobs)
      .set({
        status: "failed",
        finished_at: new Date(),
        error_message:
          err instanceof Error ? err.message.slice(0, 1000) : String(err),
      })
      .where(eq(system_jobs.id, jobId))
    throw err
  } finally {
    clearInterval(heartbeat)
    // Compare-and-delete prevents an expired lock holder from deleting a
    // newer owner's lock. Do not hide release failures.
    await lock.release()
  }
}
