// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, mock } from "bun:test"
import { Hono } from "hono"
import type { AuthUser } from "../auth/middleware"
import type { Db } from "@ploydok/db"
import type { DiskUsageResponse } from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Fake db — only `select().from().where().limit()` is exercised, by
// requireInstanceAdmin's `users.is_instance_admin` lookup.
// ---------------------------------------------------------------------------

let fakeInstanceAdmin = true
let fakeJob: Record<string, unknown> | null = null
let fakeJobs: Record<string, unknown>[] = []

const fakeDb = {
  select: mock((selection?: Record<string, unknown>) => ({
    from: () => ({
      where: () => ({
        limit: async () =>
          selection?.is_instance_admin
            ? [{ is_instance_admin: fakeInstanceAdmin }]
            : fakeJob
              ? [fakeJob]
              : [],
        orderBy: () => ({ limit: async () => fakeJobs }),
      }),
    }),
  })),
} as unknown as Db

// ---------------------------------------------------------------------------
// Mock agent — imageDf + hostStats
// ---------------------------------------------------------------------------

const mockImageDf = mock(() =>
  Promise.resolve({
    categories: [
      { kind: "images", totalBytes: 1000, reclaimableBytes: 200, count: 5 },
      {
        kind: "build_cache",
        totalBytes: 500,
        reclaimableBytes: 500,
        count: 1,
      },
    ],
    layersSizeBytes: 900,
  })
)

const mockHostStats = mock(() =>
  Promise.resolve({
    cpuPercent: 1,
    memTotalBytes: 0,
    memUsedBytes: 0,
    memAvailableBytes: 0,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    diskTotalBytes: 10_000,
    diskUsedBytes: 4_000,
    diskFreeBytes: 6_000,
    inodesTotal: 0,
    inodesUsed: 0,
    cpuCount: 1,
    uptimeSeconds: 0,
    error: "",
  })
)
const mockEnqueue = mock(() =>
  Promise.resolve({ row: { id: "cleanup-job-1" }, jobId: "cleanup-job-1" })
)

// NOTE: this file uses a dynamic `await import("./disk")` below (needed so the
// mock is registered before the route module resolves its agent singleton),
// which fully replaces the process-wide "../debug/singletons" module for the
// rest of the bun:test run. `getSharedCaddy` is stubbed too so sibling test
// files that transitively import it (e.g. via worker/index.ts →
// jobs/caddy-reconcile.ts) don't crash with a missing-export SyntaxError.
mock.module("../debug/singletons", () => ({
  getSharedAgent: () => ({
    imageDf: mockImageDf,
    hostStats: mockHostStats,
  }),
  getSharedCaddy: () => ({}),
}))
mock.module("../worker/queue-enqueue", () => ({
  enqueueWithDbRow: mockEnqueue,
  assertTransactionalQueueRegistry: () => undefined,
}))

const { createDiskRouter, resetDiskUsageCache } = await import("./disk")
let persistedUsage: DiskUsageResponse | null = null
const usageStore = {
  read: mock(async () => persistedUsage),
  write: mock(async (payload: DiskUsageResponse) => {
    persistedUsage = payload
  }),
}

// ---------------------------------------------------------------------------
// Test app builder — injects a fake auth middleware
// ---------------------------------------------------------------------------

function fakeUser(id = "user-1"): AuthUser {
  return {
    id,
    email: "test@example.com",
    display_name: "Test User",
    session_id: "sess-test",
  }
}

function buildTestApp(authedUser?: AuthUser): Hono {
  const app = new Hono()

  app.use("*", async (c, next) => {
    if (authedUser) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(c as any).set("user", authedUser)
    }
    return next()
  })

  app.route("/disk", createDiskRouter(fakeDb, usageStore))
  return app
}

async function warmUsage(app: Hono): Promise<void> {
  await app.request("/disk/usage")
  await Bun.sleep(0)
}

beforeEach(() => {
  fakeInstanceAdmin = true
  fakeJob = null
  fakeJobs = []
  mockImageDf.mockClear()
  mockHostStats.mockClear()
  mockEnqueue.mockClear()
  persistedUsage = null
  usageStore.read.mockClear()
  usageStore.write.mockClear()
  resetDiskUsageCache()
})

describe("GET /disk/jobs", () => {
  it("lists cancelled and failed partial cleanup history", async () => {
    const now = new Date()
    fakeJobs = [
      { id: "cancelled", kind: "gc.docker", status: "cancelled", result: { skipped: "another Docker cleanup is running" }, error_message: null, queued_at: now, claimed_at: now, finished_at: now },
      { id: "failed", kind: "gc.docker", status: "failed", result: { activeBuildAppsSkipped: 0, docker: { status: "succeeded" }, localCaches: { status: "pending" }, dedicatedBuildKit: { status: "failed" } }, error_message: "failed", queued_at: now, claimed_at: now, finished_at: now },
    ]
    const res = await buildTestApp(fakeUser()).request("/disk/jobs")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject([{ status: "cancelled" }, { status: "failed", result: { docker: { status: "succeeded" } } }])
  })
})

describe("POST /disk/cleanup", () => {
  it("requires authentication and instance-admin access", async () => {
    expect((await buildTestApp().request("/disk/cleanup", { method: "POST" })).status).toBe(401)
    fakeInstanceAdmin = false
    expect((await buildTestApp(fakeUser()).request("/disk/cleanup", { method: "POST" })).status).toBe(403)
  })

  it("enqueues an admin cleanup and returns its durable job id", async () => {
    const res = await buildTestApp(fakeUser()).request("/disk/cleanup", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobId: "cleanup-job-1" })
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })
})

describe("GET /disk/jobs/:jobId", () => {
  it("returns the persisted terminal result", async () => {
    fakeJob = {
      id: "job-1",
      kind: "gc.images",
      status: "succeeded",
      result: { imagesDeleted: 2, spaceReclaimedBytes: 4096 },
      error_message: null,
      queued_at: new Date("2026-07-14T10:00:00.000Z"),
      claimed_at: new Date("2026-07-14T10:00:01.000Z"),
      finished_at: new Date("2026-07-14T10:00:02.000Z"),
    }
    const app = buildTestApp(fakeUser())
    const res = await app.request("/disk/jobs/job-1")

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      jobId: "job-1",
      kind: "gc.images",
      status: "succeeded",
      result: { imagesDeleted: 2, spaceReclaimedBytes: 4096 },
    })
  })

  it("returns 404 for a missing reclaim job", async () => {
    const app = buildTestApp(fakeUser())
    const res = await app.request("/disk/jobs/missing")
    expect(res.status).toBe(404)
  })

  it("returns a cancelled contention result without violating the shared schema", async () => {
    fakeJob = { id: "job-cancelled", kind: "gc.docker", status: "cancelled", result: { skipped: "another Docker cleanup is running" }, error_message: null, queued_at: new Date(), claimed_at: new Date(), finished_at: new Date() }
    const res = await buildTestApp(fakeUser()).request("/disk/jobs/job-cancelled")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "cancelled", result: { skipped: "another Docker cleanup is running" } })
  })

  it("returns a failed cleanup with its persisted partial result", async () => {
    fakeJob = { id: "job-failed", kind: "gc.docker", status: "failed", result: { activeBuildAppsSkipped: 0, docker: { status: "succeeded" }, localCaches: { status: "succeeded" }, dedicatedBuildKit: { status: "failed", error: "dial" } }, error_message: "dial", queued_at: new Date(), claimed_at: new Date(), finished_at: new Date() }
    const res = await buildTestApp(fakeUser()).request("/disk/jobs/job-failed")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "failed", errorMessage: "dial", result: { docker: { status: "succeeded" } } })
  })
})

// ---------------------------------------------------------------------------
// GET /disk/usage
// ---------------------------------------------------------------------------

describe("GET /disk/insights", () => {
  it("requires instance-admin access", async () => {
    expect((await buildTestApp().request("/disk/insights")).status).toBe(401)
    fakeInstanceAdmin = false
    expect((await buildTestApp(fakeUser()).request("/disk/insights")).status).toBe(403)
  })

  it("returns real samples with their calculated seven-day trend", async () => {
    const now = new Date()
    fakeJobs = [
      { measured_at: new Date(now.getTime() - 7 * 86_400_000), used_bytes: 200, total_bytes: 1_000 },
      { measured_at: now, used_bytes: 270, total_bytes: 1_000 },
    ]
    const response = await buildTestApp(fakeUser()).request("/disk/insights")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ history: [{ usedBytes: 200 }, { usedBytes: 270 }], growth7dBytes: 70, daysTo90Percent: 63 })
  })
})

describe("GET /disk/usage", () => {
  it("returns 401 without an authenticated user", async () => {
    const app = buildTestApp()
    const res = await app.request("/disk/usage")
    expect(res.status).toBe(401)
  })

  it("returns 403 for a non instance-admin user", async () => {
    fakeInstanceAdmin = false
    const app = buildTestApp(fakeUser())
    const res = await app.request("/disk/usage")
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("admin_required")
  })

  it("maps the agent's ImageDf + HostStats responses into the shared DiskUsageResponse shape", async () => {
    const app = buildTestApp(fakeUser())
    await warmUsage(app)
    const res = await app.request("/disk/usage")
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      categories: Array<{
        kind: string
        totalBytes: number
        reclaimableBytes: number
        count: number
      }>
      layersSizeBytes: number
      host: { totalBytes: number; usedBytes: number; freeBytes: number; inodesTotal: number | null; inodesUsed: number | null } | null
    }

    expect(body.categories).toEqual([
      { kind: "images", totalBytes: 1000, reclaimableBytes: 200, count: 5 },
      {
        kind: "build_cache",
        totalBytes: 500,
        reclaimableBytes: 500,
        count: 1,
      },
    ])
    expect(body.layersSizeBytes).toBe(900)
    expect(body.host).toEqual({
      totalBytes: 10_000,
      usedBytes: 4_000,
      freeBytes: 6_000,
      inodesTotal: 0,
      inodesUsed: 0,
    })
    expect(mockImageDf).toHaveBeenCalledTimes(1)
    expect(mockHostStats).toHaveBeenCalledTimes(1)
  })

  it("returns host: null when hostStats fails (imageDf still succeeds)", async () => {
    mockHostStats.mockImplementationOnce(() =>
      Promise.reject(new Error("agent unavailable"))
    )
    const app = buildTestApp(fakeUser())
    const res = await app.request("/disk/usage")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { host: unknown }
    expect(body.host).toBeNull()
  })

  it("keeps host usage available and stops polling when imageDf fails", async () => {
    mockImageDf.mockImplementationOnce(() =>
      Promise.reject(new Error("agent unavailable"))
    )
    const app = buildTestApp(fakeUser())
    await warmUsage(app)
    const res = await app.request("/disk/usage")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      host: { usedBytes: 4_000 },
      refreshedAt: null,
      stale: false,
      refreshFailed: true,
    })
    expect(mockImageDf).toHaveBeenCalledTimes(1)
  })

  it("serves a second read from cache without re-walking the agent", async () => {
    const app = buildTestApp(fakeUser())
    await warmUsage(app)
    const res = await app.request("/disk/usage")

    expect(res.status).toBe(200)
    const body = (await res.json()) as { stale: boolean }
    expect(body.stale).toBe(false)
    expect(mockImageDf).toHaveBeenCalledTimes(1)
  })

  it("preserves exclusive cleanup estimates and individual consumers from the agent", async () => {
    mockImageDf.mockImplementationOnce(async () => ({
      categories: [], layersSizeBytes: 900, cleanupReclaimableBytes: 100,
      topConsumers: [{ kind: "volumes", name: "database-data", sizeBytes: 500 }],
    }))
    const app = buildTestApp(fakeUser())
    await warmUsage(app)
    expect(await (await app.request("/disk/usage")).json()).toMatchObject({
      cleanupReclaimableBytes: 100,
      topConsumers: [{ kind: "volumes", name: "database-data", sizeBytes: 500 }],
    })
  })

  it("answers ?refresh=1 from cache without waiting, and re-walks behind it", async () => {
    const app = buildTestApp(fakeUser())
    await warmUsage(app)

    let release: (() => void) | undefined
    mockImageDf.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { categories: [], layersSizeBytes: 42 }
    })

    const res = await app.request("/disk/usage?refresh=1")

    // Returned while the second walk is still blocked on `release`.
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      stale: boolean
      layersSizeBytes: number
    }
    expect(body.stale).toBe(true)
    expect(body.layersSizeBytes).toBe(900)
    expect(mockImageDf).toHaveBeenCalledTimes(2)

    release?.()
    await Bun.sleep(0)

    const after = (await (await app.request("/disk/usage")).json()) as {
      stale: boolean
      layersSizeBytes: number
    }
    expect(after.stale).toBe(false)
    expect(after.layersSizeBytes).toBe(42)
  })

  it("coalesces concurrent cold reads into a single agent walk", async () => {
    const app = buildTestApp(fakeUser())
    const [a, b, c] = await Promise.all([
      app.request("/disk/usage"),
      app.request("/disk/usage"),
      app.request("/disk/usage"),
    ])

    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect(mockImageDf).toHaveBeenCalledTimes(1)
    expect(mockHostStats).toHaveBeenCalledTimes(1)
    expect(usageStore.read).toHaveBeenCalledTimes(1)
  })

  it("returns host usage on a cold cache before a slow Docker measurement completes", async () => {
    let release: (() => void) | undefined
    mockImageDf.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { categories: [], layersSizeBytes: 42 }
    })
    const app = buildTestApp(fakeUser())
    try {
      const res = await app.request("/disk/usage")
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        host: { usedBytes: 4_000 },
        categories: [],
        refreshedAt: null,
        stale: true,
        refreshFailed: false,
      })
    } finally {
      release?.()
      await Bun.sleep(0)
    }
    expect(await (await app.request("/disk/usage")).json()).toMatchObject({
      layersSizeBytes: 42,
      stale: false,
      refreshFailed: false,
    })
  })

  it("restores the persisted Docker measurement after an API cache reset", async () => {
    const app = buildTestApp(fakeUser())
    await warmUsage(app)
    expect(usageStore.write).toHaveBeenCalledTimes(1)
    resetDiskUsageCache()
    const restartedApp = buildTestApp(fakeUser())
    expect(
      await (await restartedApp.request("/disk/usage")).json()
    ).toMatchObject({
      layersSizeBytes: 900,
      stale: false,
    })
    expect(mockImageDf).toHaveBeenCalledTimes(1)
    expect(usageStore.read).toHaveBeenCalledTimes(2)
  })

  it("serves an expired persisted measurement while Docker revalidates", async () => {
    const app = buildTestApp(fakeUser())
    await warmUsage(app)
    persistedUsage = {
      ...persistedUsage!,
      refreshedAt: new Date(Date.now() - 120_000).toISOString(),
    }
    resetDiskUsageCache()
    let release: (() => void) | undefined
    mockImageDf.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { categories: [], layersSizeBytes: 42 }
    })
    try {
      expect(await (await app.request("/disk/usage")).json()).toMatchObject({
        layersSizeBytes: 900,
        stale: true,
      })
    } finally {
      release?.()
      await Bun.sleep(0)
    }
  })

  it("bounds a stalled persisted-cache read and still serves host usage", async () => {
    usageStore.read.mockImplementationOnce(() => new Promise(() => {}))
    const app = buildTestApp(fakeUser())
    const res = await app.request("/disk/usage")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ host: { usedBytes: 4_000 } })
  })
})
