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
import { listHostDiskSamples } from "@ploydok/db/queries"
import { diskHostKey } from "../disk/host-key"
import { diskGrowth } from "../disk/history"
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

const FRESH_MS = 60_000
const CACHE_IO_TIMEOUT_MS = 250
const HOST_FRESH_MS = 5_000

interface DiskUsageStore {
  read(): Promise<DiskUsageResponse | null>
  write(payload: DiskUsageResponse): Promise<void>
}

const cacheKey = `ploydok:disk:usage:v1:${diskHostKey}`

// Reuse the application's Redis connection. This snapshot is best-effort and
// must never hold up the page when Redis is unavailable.
const redisUsageStore: DiskUsageStore = {
  async read() {
    const redis = await dockerCleanupQueue.client
    const raw = await redis.get(cacheKey)
    if (!raw) return null
    const payload = DiskUsageResponseSchema.parse(JSON.parse(raw))
    return payload.refreshedAt ? payload : null
  },
  async write(payload) {
    const redis = await dockerCleanupQueue.client
    await redis.set(cacheKey, JSON.stringify(payload), { EX: 86_400 })
  },
}

async function boundedCacheIo<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Disk cache timed out")),
          CACHE_IO_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

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
let restored = false
let restoring: Promise<void> | null = null
let refreshFailedAt: number | null = null
let hostCache: { payload: DiskUsageResponse["host"]; at: number } | null = null
let hostInflight: Promise<DiskUsageResponse["host"]> | null = null

async function collectDiskUsage(): Promise<DiskUsageResponse> {
  const agent = getSharedAgent()
  const df = await agent.imageDf({})

  return DiskUsageResponseSchema.parse({
    categories: df.categories.map((cat) => ({
      kind: cat.kind,
      totalBytes: cat.totalBytes,
      reclaimableBytes: cat.reclaimableBytes,
      count: cat.count,
    })),
    layersSizeBytes: df.layersSizeBytes,
    cleanupReclaimableBytes: df.cleanupReclaimableBytes ?? null,
    topConsumers: df.topConsumers ?? [],
    host: null,
    refreshedAt: new Date().toISOString(),
    stale: false,
  })
}

async function readHostUsage(): Promise<DiskUsageResponse["host"]> {
  if (hostCache && Date.now() - hostCache.at < HOST_FRESH_MS)
    return hostCache.payload
  if (hostInflight) return hostInflight
  const generation = walkSeq
  const promise = getSharedAgent()
    .hostStats({}, 1_000)
    .then((stats) => ({
      totalBytes: stats.diskTotalBytes,
      usedBytes: stats.diskUsedBytes,
      freeBytes: stats.diskFreeBytes,
      inodesTotal: stats.inodesTotal,
      inodesUsed: stats.inodesUsed,
    }))
    .catch((err) => {
      log.warn(
        { err },
        "hostStats unavailable; serving the last host measurement"
      )
      return hostCache?.payload ?? null
    })
    .then((payload) => {
      if (generation === walkSeq) hostCache = { payload, at: Date.now() }
      return payload
    })
    .finally(() => {
      if (hostInflight === promise) hostInflight = null
    })
  hostInflight = promise
  return promise
}

function restoreDiskUsage(store: DiskUsageStore): Promise<void> {
  if (restored) return Promise.resolve()
  if (restoring) return restoring
  const generation = walkSeq
  const promise = boundedCacheIo(store.read())
    .then((payload) => {
      if (payload?.refreshedAt && generation === walkSeq) {
        cached = {
          payload,
          at: Date.parse(payload.refreshedAt),
          gen: generation,
        }
      }
    })
    .catch((err) => log.warn({ err }, "disk usage cache unavailable"))
    .finally(() => {
      if (restoring === promise) {
        restored = true
        restoring = null
      }
    })
  restoring = promise
  return promise
}

// Single-flight. `notBefore` lets a forced refresh reject an in-flight walk
// that started before the caller's event (a prune that just finished), while
// background revalidations happily join whatever is already running.
function refreshDiskUsage(
  store: DiskUsageStore,
  notBefore = 0
): Promise<DiskUsageResponse> {
  if (inflight && inflight.at >= notBefore) return inflight.promise

  const at = Date.now()
  const gen = ++walkSeq
  const promise = collectDiskUsage()
    .then((payload) => {
      // Two walks can overlap when a forced refresh preempts a background one.
      // Whoever started last wins, whatever the completion order.
      if (walkSeq === gen) {
        cached = { payload, at: Date.now(), gen }
        refreshFailedAt = null
        void boundedCacheIo(store.write(payload)).catch((err) => {
          log.warn({ err }, "could not persist disk usage cache")
        })
      }
      return payload
    })
    .catch((err) => {
      if (walkSeq === gen) refreshFailedAt = Date.now()
      throw err
    })
    .finally(() => {
      if (inflight?.gen === gen) inflight = null
    })

  inflight = { at, gen, promise }
  return promise
}

// Exposed for tests: module state outlives a single request by design.
export function resetDiskUsageCache(): void {
  ++walkSeq
  cached = null
  inflight = null
  restored = false
  restoring = null
  refreshFailedAt = null
  hostCache = null
  hostInflight = null
}

export function createDiskRouter(
  db: Db,
  usageStore: DiskUsageStore = redisUsageStore
): Hono<AppEnv> {
  const router = new Hono<AppEnv>()
  const instanceAdmin = requireInstanceAdmin(db)

  router.get("/insights", instanceAdmin, async (c) => {
    const rows = await listHostDiskSamples(db, diskHostKey, new Date(Date.now() - 30 * 86_400_000))
    const history = rows.map((row) => ({ measuredAt: row.measured_at.toISOString(), usedBytes: row.used_bytes, totalBytes: row.total_bytes }))
    return c.json({ history, ...diskGrowth(history) })
  })

  // Host stats and a persisted snapshot are cheap. Docker's layer walk always
  // runs behind the response, including the first visit after an API restart.
  router.get("/usage", instanceAdmin, async (c) => {
    const forced = c.req.query("refresh") === "1"
    const [host] = await Promise.all([
      readHostUsage(),
      restoreDiskUsage(usageStore),
    ])
    const fresh = cached && Date.now() - cached.at < FRESH_MS
    const retryDue =
      refreshFailedAt === null || Date.now() - refreshFailedAt >= FRESH_MS
    if (forced || (!fresh && retryDue)) {
      void refreshDiskUsage(usageStore, forced ? Date.now() : 0).catch(
        (err) => {
          log.warn({ err }, "background disk usage refresh failed")
        }
      )
    }
    return c.json(
      DiskUsageResponseSchema.parse({
        ...(cached?.payload ?? {
          categories: [],
          layersSizeBytes: 0,
          refreshedAt: null,
        }),
        host,
        stale: inflight !== null,
        refreshFailed: refreshFailedAt !== null,
      })
    )
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
      .where(
        inArray(system_jobs.kind, ["gc.images", "gc.buildcache", "gc.docker"])
      )
      .orderBy(desc(system_jobs.queued_at))
      .limit(20)
    return c.json(
      rows.map((job) =>
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
    )
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
