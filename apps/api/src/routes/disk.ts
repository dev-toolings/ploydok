// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import { nanoid } from "nanoid"
import { and, desc, eq, inArray } from "drizzle-orm"
import { system_jobs } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import {
  DiskJobStatusSchema,
  DiskPruneResultSchema,
  DiskUsageResponseSchema,
} from "@ploydok/shared"
import type { AuthUser } from "../auth/middleware"
import type { DiskUsageResponse } from "@ploydok/shared"
import { requireInstanceAdmin } from "../auth/instance-admin"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"
import { enqueueWithDbRow } from "../worker/queue-enqueue"
import {
  dockerCleanupQueue,
  gcBuildCacheQueue,
  gcImagesQueue,
} from "../worker/queues"

type AppEnv = { Variables: { user?: AuthUser } }

const log = childLogger("disk.routes")

function getUser(c: { get: (key: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

// ---------------------------------------------------------------------------
// Disk usage cache
//
// The agent's ImageDf maps to `GET /system/df`, whose image branch walks the
// whole layer store: measured at ~7 s on a 82-image host, and dockerd caches
// nothing. Serving that synchronously turned every visit to /admin/disk into a
// 7 s spinner, so reads go through a stale-while-revalidate cache: a fresh
// entry answers in microseconds, a stale one answers immediately and kicks off
// a background refresh, and only a cold process pays the full walk.
// ---------------------------------------------------------------------------

const FRESH_MS = 60_000

let cached: { payload: DiskUsageResponse; at: number; gen: number } | null =
  null
let inflight: {
  at: number
  gen: number
  promise: Promise<DiskUsageResponse>
} | null = null
// Walks are ordered by this counter, not by `at`: two of them can start within
// the same millisecond and a wall-clock comparison then drops the newer result.
let walkSeq = 0

async function collectDiskUsage(): Promise<DiskUsageResponse> {
  const agent = getSharedAgent()

  // Independent RPCs: hostStats samples CPU for 100 ms and must not queue
  // behind the df walk.
  const [dfResult, hostResult] = await Promise.allSettled([
    agent.imageDf({}),
    agent.hostStats({}),
  ])

  if (dfResult.status === "rejected") throw dfResult.reason

  let host: DiskUsageResponse["host"] = null
  if (hostResult.status === "fulfilled") {
    host = {
      totalBytes: hostResult.value.diskTotalBytes,
      usedBytes: hostResult.value.diskUsedBytes,
      freeBytes: hostResult.value.diskFreeBytes,
    }
  } else {
    log.warn(
      { err: hostResult.reason },
      "hostStats unavailable — disk.host will be null"
    )
  }

  return DiskUsageResponseSchema.parse({
    categories: dfResult.value.categories.map((cat) => ({
      kind: cat.kind,
      totalBytes: cat.totalBytes,
      reclaimableBytes: cat.reclaimableBytes,
      count: cat.count,
    })),
    layersSizeBytes: dfResult.value.layersSizeBytes,
    host,
    refreshedAt: new Date().toISOString(),
    stale: false,
  })
}

// Single-flight. `notBefore` lets a forced refresh reject an in-flight walk
// that started before the caller's event (a prune that just finished), while
// background revalidations happily join whatever is already running.
function refreshDiskUsage(notBefore = 0): Promise<DiskUsageResponse> {
  if (inflight && inflight.at >= notBefore) return inflight.promise

  const at = Date.now()
  const gen = ++walkSeq
  const promise = collectDiskUsage()
    .then((payload) => {
      // Two walks can overlap when a forced refresh preempts a background one.
      // Whoever started last wins, whatever the completion order.
      if (!cached || cached.gen < gen) cached = { payload, at, gen }
      return payload
    })
    .finally(() => {
      if (inflight?.gen === gen) inflight = null
    })

  inflight = { at, gen, promise }
  return promise
}

// Exposed for tests: module state outlives a single request by design.
export function resetDiskUsageCache(): void {
  cached = null
  inflight = null
}

export function createDiskRouter(db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()
  const instanceAdmin = requireInstanceAdmin(db)

  // GET /disk/usage — `docker system df` breakdown + host filesystem usage.
  //
  // Never blocks on the walk when a previous measurement exists, including for
  // `?refresh=1` (used by the Refresh button and after a prune job): the
  // caller gets the last known breakdown flagged `stale` and polls until the
  // refresh lands. Only a cold process has to wait.
  router.get("/usage", instanceAdmin, async (c) => {
    const forced = c.req.query("refresh") === "1"

    if (cached) {
      const fresh = !forced && Date.now() - cached.at < FRESH_MS
      if (!fresh) {
        // A failing revalidation keeps the last good value rather than
        // blanking the page.
        void refreshDiskUsage(forced ? Date.now() : 0).catch((err) => {
          log.warn({ err }, "background disk usage refresh failed")
        })
      }
      // `inflight` covers the window where a refresh triggered by an earlier
      // request is still running: reporting `stale: false` there would stop
      // the dashboard from polling and freeze it on the previous numbers.
      return c.json({ ...cached.payload, stale: inflight !== null })
    }

    try {
      return c.json(await refreshDiskUsage())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "AGENT_ERROR", message } }, 502)
    }
  })

  router.get("/jobs/:jobId", instanceAdmin, async (c) => {
    const rows = await db
      .select()
      .from(system_jobs)
      .where(
        and(
          eq(system_jobs.id, c.req.param("jobId")!),
          inArray(system_jobs.kind, ["gc.images", "gc.buildcache", "gc.docker"])
        )
      )
      .limit(1)
    const job = rows[0]
    if (!job) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Disk job not found" } },
        404
      )
    }

    return c.json(
      DiskJobStatusSchema.parse({
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        result: job.result ?? null,
        errorMessage: job.error_message,
        queuedAt: job.queued_at.toISOString(),
        startedAt: job.claimed_at?.toISOString() ?? null,
        finishedAt: job.finished_at?.toISOString() ?? null,
      })
    )
  })

  router.get("/jobs", instanceAdmin, async (c) => {
    const rows = await db
      .select()
      .from(system_jobs)
      .where(inArray(system_jobs.kind, ["gc.images", "gc.buildcache", "gc.docker"]))
      .orderBy(desc(system_jobs.queued_at))
      .limit(20)
    return c.json(rows.map((job) => DiskJobStatusSchema.parse({
      jobId: job.id, kind: job.kind, status: job.status, result: job.result ?? null,
      errorMessage: job.error_message, queuedAt: job.queued_at.toISOString(),
      startedAt: job.claimed_at?.toISOString() ?? null,
      finishedAt: job.finished_at?.toISOString() ?? null,
    })))
  })

  // POST /disk/prune/images — dangling-only image prune (all: false, safe default).
  router.post("/prune/images", instanceAdmin, async (c) => {
    const user = getUser(c)
    try {
      const { row } = await enqueueWithDbRow({
        db,
        queue: gcImagesQueue,
        jobName: "gc.images.requested",
        insertRow: (tx) =>
          tx
            .insert(system_jobs)
            .values({
              id: nanoid(),
              kind: "gc.images",
              requested_by_user_id: user.id,
              source: "api",
              options: {},
            })
            .returning()
            .then((r: (typeof system_jobs.$inferSelect)[]) => r[0]!),
        buildPayload: (row) => ({ jobId: row.id }),
      })
      return c.json(DiskPruneResultSchema.parse({ jobId: row.id }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "PRUNE_FAILED", message } }, 500)
    }
  })

  // POST /disk/prune/build-cache — host Docker builder cache prune.
  router.post("/prune/build-cache", instanceAdmin, async (c) => {
    const user = getUser(c)
    try {
      const { row } = await enqueueWithDbRow({
        db,
        queue: gcBuildCacheQueue,
        jobName: "gc.buildcache.requested",
        insertRow: (tx) =>
          tx
            .insert(system_jobs)
            .values({
              id: nanoid(),
              kind: "gc.buildcache",
              requested_by_user_id: user.id,
              source: "api",
              options: {},
            })
            .returning()
            .then((r: (typeof system_jobs.$inferSelect)[]) => r[0]!),
        buildPayload: (row) => ({ jobId: row.id }),
      })
      return c.json(DiskPruneResultSchema.parse({ jobId: row.id }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "PRUNE_FAILED", message } }, 500)
    }
  })

  // POST /disk/cleanup — full fixed Docker cleanup, including tagged unused
  // images. The agent owns the policy and never receives arbitrary commands.
  router.post("/cleanup", instanceAdmin, async (c) => {
    const user = getUser(c)
    try {
      const { row } = await enqueueWithDbRow({
        db,
        queue: dockerCleanupQueue,
        jobName: "gc.docker.requested",
        insertRow: (tx) =>
          tx
            .insert(system_jobs)
            .values({
              id: nanoid(),
              kind: "gc.docker",
              requested_by_user_id: user.id,
              source: "api",
              options: {},
            })
            .returning()
            .then((r: (typeof system_jobs.$inferSelect)[]) => r[0]!),
        buildPayload: (row) => ({ jobId: row.id }),
      })
      return c.json(DiskPruneResultSchema.parse({ jobId: row.id }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "CLEANUP_FAILED", message } }, 500)
    }
  })

  return router
}
