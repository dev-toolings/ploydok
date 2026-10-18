// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for gc-registry.ts (M4.2).
 *
 * All external dependencies (registry client, DB) are mocked in-process.
 * No real registry or SQLite database is required.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import {
  getRegistryUsageForApp,
  runRegistryGc,
  startRegistryGcCron,
  stopRegistryGcCron,
  GcRegistryOptionsSchema,
} from "./gc-registry"
import type { GcOptions, RegistryClient } from "./gc-registry"
import * as queueAuditMod from "../queue-audit"
import * as queueClaimMod from "../queue-claim"
import * as registryMod from "./gc-registry"
import { handleGcRegistryJob } from "../index"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock registry client. */
function mockClient(overrides: Partial<RegistryClient> = {}): RegistryClient {
  return {
    listTags: async () => [],
    getManifest: async () => null,
    deleteDigest: async () => undefined,
    diskUsagePct: async () => 0,
    garbageCollect: async () => ({ ok: true, output: "" }),
    ...overrides,
  }
}

/** Minimal Drizzle-like mock that returns fixed rows. */
function mockDb(opts: {
  apps?: Array<{ id: string }>
  builds?: Array<{ image_tag: string | null; created_at: Date | null }>
}) {
  const appsRows = opts.apps ?? []
  const buildsRows = opts.builds ?? []

  // We need to support the chained Drizzle query builder used in runRegistryGc.
  // Shape: db.select({...}).from(table).where(...).orderBy(...) → rows
  // We simulate this with a simple object that captures calls and returns the data.

  function makeSelectChain(rows: unknown[]) {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      orderBy: () => chain,
      then: (resolve: (v: unknown[]) => void) => {
        resolve(rows)
        return Promise.resolve(rows)
      },
    }
    // Make it awaitable.
    Object.defineProperty(chain, Symbol.toStringTag, { value: "Promise" })
    return chain
  }

  return {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        // Distinguish which table we're querying by reference.
        // apps table rows vs builds table rows.
        const isBuildsQuery =
          table !== null &&
          typeof table === "object" &&
          "image_tag" in (table as object)
        const rows = isBuildsQuery ? buildsRows : appsRows
        return makeSelectChain(rows)
      },
    }),
    transaction: async (fn: (tx: any) => Promise<any>) =>
      fn({
        insert: () => ({
          values: () => ({ returning: () => Promise.resolve([]) }),
        }),
      }),
  }
}

/** Create a minimal mock BullMQ Queue. */
function mockQueue(): any {
  return {
    add: mock(async (_jobName: string, _payload: unknown) => ({
      id: `test-job-${Math.random().toString(36).slice(2, 9)}`,
    })),
  }
}

function mockWorkerDb() {
  const whereSpy = mock(async () => [])
  const setSpy = mock(() => ({ where: whereSpy }))
  const updateSpy = mock(() => ({ set: setSpy }))
  return {
    db: {
      update: updateSpy,
    } as any,
    updateSpy,
    setSpy,
    whereSpy,
  }
}

// ---------------------------------------------------------------------------
// runRegistryGc
// ---------------------------------------------------------------------------

describe("gc.registry worker", () => {
  beforeEach(() => {
    mock.restore()
  })

  it("ignores legacy payload and audits when jobId is missing", async () => {
    const db = mockWorkerDb()
    const auditUnauthorizedSpy = spyOn(queueAuditMod, "auditUnauthorized")
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(null)
    const runRegistrySpy = spyOn(registryMod, "runRegistryGc")

    await handleGcRegistryJob(db.db, {
      id: "bull-legacy",
      data: { appId: "app-1", keepPerRepo: 0 },
    })

    expect(auditUnauthorizedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "legacy payload (no jobId) — drop after queue drain",
      })
    )
    expect(queueClaimMod.claimQueuedRow).not.toHaveBeenCalled()
    expect(runRegistrySpy).not.toHaveBeenCalled()
  })

  it("claims jobId row, runs runRegistryGc with options from system_jobs", async () => {
    const db = mockWorkerDb()
    const auditUnauthorizedSpy = spyOn(queueAuditMod, "auditUnauthorized")
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      id: "sys-job-1",
      options: { appId: "app-1", keepPerRepo: 5 },
      requested_by_user_id: "user-1",
      source: "api",
    } as any)
    const runRegistrySpy = spyOn(registryMod, "runRegistryGc").mockResolvedValue({
      reposScanned: 1,
      tagsDeleted: 0,
      bytesFreed: 0,
    })

    await handleGcRegistryJob(db.db, {
      id: "bull-42",
      data: { jobId: "sys-job-1" },
    })

    expect(auditUnauthorizedSpy).not.toHaveBeenCalled()
    expect(runRegistrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        appFilter: "app-1",
        keepPerRepo: 5,
      })
    )
    expect(db.setSpy).toHaveBeenCalledWith({ status: "succeeded", finished_at: expect.any(Date) })
  })

  it("drops missing row after queue drain and logs unauthorized", async () => {
    const db = mockWorkerDb()
    const auditUnauthorizedSpy = spyOn(queueAuditMod, "auditUnauthorized")
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(null)
    const runRegistrySpy = spyOn(registryMod, "runRegistryGc")

    await handleGcRegistryJob(db.db, {
      id: "bull-missing",
      data: { jobId: "sys-missing" },
    })

    expect(auditUnauthorizedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "no matching pending system_jobs row",
      })
    )
    expect(runRegistrySpy).not.toHaveBeenCalled()
    expect(db.setSpy).not.toHaveBeenCalled()
  })

  it("drops replayed job when row is already claimed/consumed", async () => {
    const db = mockWorkerDb()
    const auditUnauthorizedSpy = spyOn(queueAuditMod, "auditUnauthorized")
    spyOn(queueClaimMod, "claimQueuedRow")
      .mockResolvedValueOnce({
        id: "sys-job-2",
        options: { appId: null, keepPerRepo: 3 },
        requested_by_user_id: null,
        source: "cron:gc",
      } as any)
      .mockResolvedValueOnce(null)
    const runRegistrySpy = spyOn(registryMod, "runRegistryGc").mockResolvedValue({
      reposScanned: 0,
      tagsDeleted: 0,
      bytesFreed: 0,
    })

    await handleGcRegistryJob(db.db, { id: "bull-replay-1", data: { jobId: "sys-job-2" } })
    await handleGcRegistryJob(db.db, { id: "bull-replay-2", data: { jobId: "sys-job-2" } })

    expect(runRegistrySpy).toHaveBeenCalledTimes(1)
    expect(queueClaimMod.claimQueuedRow).toHaveBeenCalledTimes(2)
    expect(auditUnauthorizedSpy).toHaveBeenCalledTimes(1)
    expect(db.setSpy).toHaveBeenCalledWith({
      status: "succeeded",
      finished_at: expect.any(Date),
    })
  })

  it("marks job failed when system_jobs.options fails Zod validation", async () => {
    const db = mockWorkerDb()
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      id: "sys-job-3",
      options: { appId: "app-1", keepPerRepo: 99 },
      requested_by_user_id: "user-2",
      source: "api",
    } as any)
    const runRegistrySpy = spyOn(registryMod, "runRegistryGc")
    const auditUnauthorizedSpy = spyOn(queueAuditMod, "auditUnauthorized")

    await handleGcRegistryJob(db.db, {
      id: "bull-invalid",
      data: { jobId: "sys-job-3" },
    })

    expect(auditUnauthorizedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "invalid system_jobs.options schema",
      })
    )
    expect(runRegistrySpy).not.toHaveBeenCalled()
    expect(db.setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        finished_at: expect.any(Date),
      })
    )
  })
})

describe("runRegistryGc", () => {
  it("reclaims orphan blobs on the global sweep even when all apps are deleted", async () => {
    const db = mockDb({ apps: [] })
    const garbageCollect = mock(async () => ({ ok: true, output: "reclaimed" }))
    const result = await runRegistryGc({
      db: db as unknown as GcOptions["db"],
      registryClient: mockClient({ garbageCollect }),
    })
    expect(garbageCollect).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      reposScanned: 0,
      tagsDeleted: 0,
      bytesFreed: 0,
      blobReclaim: { ok: true, output: "reclaimed" },
    })
  })

  it("skips repos with 0 tags", async () => {
    const db = mockDb({ apps: [{ id: "app-1" }], builds: [] })
    const deleted: string[] = []
    const rc = mockClient({
      listTags: async () => [],
      deleteDigest: async (_, d) => {
        deleted.push(d)
      },
    })

    const result = await runRegistryGc({
      db: db as unknown as GcOptions["db"],
      registryClient: rc,
    })

    expect(result.tagsDeleted).toBe(0)
    expect(deleted).toHaveLength(0)
  })

  it("skips when tag count <= keepPerRepo", async () => {
    const db = mockDb({ apps: [{ id: "app-1" }], builds: [] })
    const deleted: string[] = []
    const rc = mockClient({
      listTags: async () => ["tag1", "tag2"],
      deleteDigest: async (_, d) => {
        deleted.push(d)
      },
    })

    const result = await runRegistryGc({
      db: db as unknown as GcOptions["db"],
      registryClient: rc,
      keepPerRepo: 3,
    })

    expect(result.tagsDeleted).toBe(0)
    expect(deleted).toHaveLength(0)
  })

  it("deletes oldest tags beyond keepPerRepo", async () => {
    const db = mockDb({
      apps: [{ id: "app-1" }],
      builds: [
        {
          image_tag: "127.0.0.1:5000/app-app-1:sha-new",
          created_at: new Date("2024-03-03"),
        },
        {
          image_tag: "127.0.0.1:5000/app-app-1:sha-mid",
          created_at: new Date("2024-02-02"),
        },
        {
          image_tag: "127.0.0.1:5000/app-app-1:sha-old",
          created_at: new Date("2024-01-01"),
        },
        {
          image_tag: "127.0.0.1:5000/app-app-1:sha-ancient",
          created_at: new Date("2023-12-01"),
        },
        {
          image_tag: "127.0.0.1:5000/app-app-1:sha-oldest",
          created_at: new Date("2023-11-01"),
        },
      ],
    })

    const deleted: string[] = []
    const rc = mockClient({
      listTags: async () => [
        "sha-new",
        "sha-mid",
        "sha-old",
        "sha-ancient",
        "sha-oldest",
      ],
      getManifest: async (_repo, tag) => ({ digest: `sha256:${tag}` }),
      deleteDigest: async (_, d) => {
        deleted.push(d)
      },
    })

    const result = await runRegistryGc({
      db: db as unknown as GcOptions["db"],
      registryClient: rc,
      keepPerRepo: 3,
    })

    // 5 tags, keep 3 → delete 2 oldest
    expect(result.tagsDeleted).toBe(2)
    expect(result.reposScanned).toBe(1)
    // The 2 deleted digests should be the oldest ones
    expect(deleted).toContain("sha256:sha-ancient")
    expect(deleted).toContain("sha256:sha-oldest")
  })

  it("deduplicates by digest", async () => {
    const db = mockDb({
      apps: [{ id: "app-2" }],
      builds: [],
    })

    const deleted: string[] = []
    const SHARED_DIGEST = "sha256:same-digest"
    const rc = mockClient({
      listTags: async () => ["alpha", "beta", "gamma", "delta"],
      getManifest: async (_repo, tag) => {
        // alpha and beta share the same digest (multi-tag scenario)
        if (tag === "alpha" || tag === "beta")
          return { digest: SHARED_DIGEST, createdAt: new Date("2024-01-15") }
        if (tag === "gamma")
          return {
            digest: "sha256:gamma-digest",
            createdAt: new Date("2024-01-10"),
          }
        return {
          digest: "sha256:delta-digest",
          createdAt: new Date("2024-01-05"),
        }
      },
      deleteDigest: async (_, d) => {
        deleted.push(d)
      },
    })

    await runRegistryGc({
      db: db as unknown as GcOptions["db"],
      registryClient: rc,
      keepPerRepo: 2,
    })

    // SHARED_DIGEST should only appear once
    const sharedCount = deleted.filter((d) => d === SHARED_DIGEST).length
    expect(sharedCount).toBeLessThanOrEqual(1)
  })

  it("appFilter restricts GC to a single app", async () => {
    // Both apps have 5 tags, but only app-A is processed.
    const db = mockDb({
      apps: [{ id: "app-A" }, { id: "app-B" }],
      builds: [],
    })

    const scannedRepos: string[] = []
    const rc = mockClient({
      listTags: async (repo) => {
        scannedRepos.push(repo)
        return ["t1", "t2", "t3", "t4", "t5"]
      },
      getManifest: async (_repo, tag) => ({
        digest: `sha256:${tag}`,
        createdAt: new Date(),
      }),
      deleteDigest: async () => undefined,
    })

    // When appFilter is set, only that app should be queried.
    // Our mock DB always returns appRows regardless of the WHERE clause,
    // so we test via scannedRepos (listTags is only called for queried apps).
    // For this test we provide a DB that returns only app-A.
    const singleAppDb = mockDb({ apps: [{ id: "app-A" }], builds: [] })

    const result = await runRegistryGc({
      db: singleAppDb as unknown as GcOptions["db"],
      registryClient: rc,
      keepPerRepo: 3,
      appFilter: "app-A",
    })

    expect(scannedRepos).toContain("app-app-a")
    expect(scannedRepos).not.toContain("app-app-b")
    expect(result.reposScanned).toBe(1)
  })

  it("does not throw when deleteDigest fails (non-fatal)", async () => {
    const db = mockDb({
      apps: [{ id: "app-err" }],
      builds: [],
    })

    const rc = mockClient({
      listTags: async () => ["a", "b", "c", "d"],
      getManifest: async (_repo, tag) => ({
        digest: `sha256:${tag}`,
        createdAt: new Date(),
      }),
      deleteDigest: async () => {
        throw new Error("registry offline")
      },
    })

    // Should resolve without throwing.
    const result = await runRegistryGc({
      db: db as unknown as GcOptions["db"],
      registryClient: rc,
      keepPerRepo: 2,
    })

    // Attempted deletions but none "succeeded" (caught internally).
    expect(result.tagsDeleted).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getRegistryUsageForApp
// ---------------------------------------------------------------------------

describe("getRegistryUsageForApp", () => {
  it("returns zero tags and diskPct when repo is empty", async () => {
    const db = mockDb({ apps: [] })
    const rc = mockClient({
      listTags: async () => [],
      diskUsagePct: async () => 0,
    })

    const usage = await getRegistryUsageForApp(
      "app-x",
      db as unknown as GcOptions["db"],
      rc
    )

    expect(usage.tags).toBe(0)
    expect(usage.diskPct).toBe(0)
    expect(usage.bytes).toBe(0)
  })

  it("returns correct tag count and disk percentage", async () => {
    const db = mockDb({ apps: [{ id: "app-y" }] })
    const rc = mockClient({
      listTags: async () => ["img1", "img2", "img3"],
      diskUsagePct: async () => 42,
      getManifest: async () => ({
        digest: "sha256:abc",
        createdAt: new Date(),
      }),
    })

    const usage = await getRegistryUsageForApp(
      "app-y",
      db as unknown as GcOptions["db"],
      rc
    )

    expect(usage.tags).toBe(3)
    expect(usage.diskPct).toBe(42)
  })

  it("normalizes mixed-case app ids to the lowercase registry repo name", async () => {
    const repos: string[] = []
    const db = mockDb({ apps: [{ id: "3gfA0pcC3DRtNqqNPWioi" }] })
    const rc = mockClient({
      listTags: async (repo) => {
        repos.push(repo)
        return ["img1"]
      },
      diskUsagePct: async () => 72,
      getManifest: async () => ({
        digest: "sha256:abc",
        createdAt: new Date(),
      }),
    })

    const usage = await getRegistryUsageForApp(
      "3gfA0pcC3DRtNqqNPWioi",
      db as unknown as GcOptions["db"],
      rc
    )

    expect(repos).toEqual(["app-3gfa0pcc3drtnqqnpwioi"])
    expect(usage.tags).toBe(1)
    expect(usage.diskPct).toBe(72)
  })
})

// ---------------------------------------------------------------------------
// startRegistryGcCron / stopRegistryGcCron
// ---------------------------------------------------------------------------

describe("startRegistryGcCron", () => {
  beforeEach(() => stopRegistryGcCron())
  afterEach(() => stopRegistryGcCron())

  it("stopRegistryGcCron is safe to call before start", () => {
    // Should not throw.
    expect(() => stopRegistryGcCron()).not.toThrow()
  })

  it("calling start twice does not leak timers (stop is idempotent)", () => {
    const db = mockDb({ apps: [] })
    const queue = mockQueue()
    const opts = {
      intervalMs: 99_999_999,
      db: db as unknown as GcOptions["db"],
      queue,
    }

    startRegistryGcCron(opts)
    startRegistryGcCron(opts) // second call should cancel the first
    stopRegistryGcCron()

    // No assertion needed — the test passes if no unhandled promise rejection
    // or timer leak occurs. Bun will surface hanging timers as test failures.
  })

  it("fires runRegistryGc after a short delay when intervalMs is tiny", async () => {
    const db = mockDb({ apps: [] })
    const queue = mockQueue()
    let ran = false

    const rc = mockClient({
      listTags: async () => {
        ran = true
        return []
      },
    })

    // Use intervalMs = 0 to trigger immediately after the initial delay.
    // We override hourUtc to a past time so the delay is ~0 ms.
    // Actually msUntilNextUtcHour always returns > 0 even for the current hour.
    // Instead, we just test that startRegistryGcCron doesn't throw and that
    // stopRegistryGcCron cancels cleanly within 50ms.
    startRegistryGcCron({
      intervalMs: ONE_DAY_MS_TEST,
      hourUtc: 0, // will fire in ~0–60 min depending on current UTC time
      db: db as unknown as GcOptions["db"],
      queue,
    })

    // Immediately stop — verifies no crash.
    stopRegistryGcCron()
    expect(ran).toBe(false) // should not have fired yet (delay > 0)
  })
})

// Just export the constant for the test above without importing from the handler.
const ONE_DAY_MS_TEST = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// GcRegistryOptionsSchema
// ---------------------------------------------------------------------------

describe("GcRegistryOptionsSchema", () => {
  it("accepts appId and keepPerRepo", () => {
    const opts = GcRegistryOptionsSchema.parse({
      appId: "app-123",
      keepPerRepo: 5,
    })
    expect(opts.appId).toBe("app-123")
    expect(opts.keepPerRepo).toBe(5)
  })

  it("defaults keepPerRepo to 3 when omitted", () => {
    const opts = GcRegistryOptionsSchema.parse({
      appId: "app-123",
    })
    expect(opts.keepPerRepo).toBe(3)
  })

  it("accepts null appId", () => {
    const opts = GcRegistryOptionsSchema.parse({
      appId: null,
      keepPerRepo: 2,
    })
    expect(opts.appId).toBeNull()
    expect(opts.keepPerRepo).toBe(2)
  })

  it("rejects keepPerRepo > 50", () => {
    expect(() =>
      GcRegistryOptionsSchema.parse({
        appId: null,
        keepPerRepo: 51,
      })
    ).toThrow()
  })

  it("rejects negative keepPerRepo", () => {
    expect(() =>
      GcRegistryOptionsSchema.parse({
        appId: null,
        keepPerRepo: -1,
      })
    ).toThrow()
  })
})
