// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import type { Agent } from "../agent"
import type { Db } from "@ploydok/db"
import {
  deriveLiveStatus,
  loadAppContainerIndex,
  reconcileAppStatusFromIndex,
  type AppContainerIndex,
} from "./app-status-reconciler"

function snap(opts: {
  id: string
  appId: string
  status: string
  name?: string
  lastSeenMs?: number
}) {
  return {
    id: opts.id,
    name: opts.name ?? `ploydok-app-${opts.appId}-blue`,
    image: "img",
    status: opts.status,
    uptimeS: 0,
    cpuPct: 0,
    memBytes: 0,
    memLimitBytes: 0,
    restartCount: 0,
    kind: "app",
    appId: opts.appId,
    color: "blue",
    lastPingMs: 0,
    lastPingOk: false,
    lastSeenMs: opts.lastSeenMs ?? Date.now(),
  }
}

function emptyIndex(): AppContainerIndex {
  return {
    byContainerId: new Map(),
    byContainerName: new Map(),
    bestByAppId: new Map(),
  }
}

async function buildIndex(
  containers: ReturnType<typeof snap>[]
): Promise<AppContainerIndex> {
  const agent = {
    listContainers: mock(async () => ({ containers })),
  } as unknown as Agent
  const idx = await loadAppContainerIndex(agent)
  if (!idx) throw new Error("loadAppContainerIndex returned null")
  return idx
}

const NOW = 1_777_171_348_000
const FRESH_UPDATED_AT = new Date(NOW - 5_000)
const STALE_UPDATED_AT = new Date(NOW - 120_000)

describe("deriveLiveStatus", () => {
  it("flips running → failed when container is stopped", async () => {
    const idx = await buildIndex([
      snap({ id: "ctr-1", appId: "app-1", status: "stopped" }),
    ])
    const next = deriveLiveStatus(
      {
        id: "app-1",
        status: "running",
        container_id: "ctr-1",
        updated_at: STALE_UPDATED_AT,
      },
      idx,
      NOW
    )
    expect(next).toBe("failed")
  })

  it("flips failed → running when container is alive again", async () => {
    const idx = await buildIndex([
      snap({ id: "ctr-2", appId: "app-2", status: "running" }),
    ])
    const next = deriveLiveStatus(
      {
        id: "app-2",
        status: "failed",
        container_id: "ctr-2",
        updated_at: FRESH_UPDATED_AT,
      },
      idx,
      NOW
    )
    expect(next).toBe("running")
  })

  it("does not resurrect an uncommitted Swarm deploy from a stale task", async () => {
    for (const taskStatus of ["starting", "unhealthy"] as const) {
      const idx = await buildIndex([
        snap({ id: "task-failed", appId: "app-failed", status: taskStatus }),
      ])
      const next = deriveLiveStatus(
        {
          id: "app-failed",
          status: "failed",
          container_id: null,
          runtime_mode: "swarm",
          swarm_service_name: null,
          updated_at: STALE_UPDATED_AT,
        },
        idx,
        NOW
      )
      expect(next).toBeNull()
    }
  })

  it("recovers an established Swarm app from a live task", async () => {
    const idx = await buildIndex([
      snap({ id: "task-live", appId: "app-established", status: "running" }),
    ])
    const next = deriveLiveStatus(
      {
        id: "app-established",
        status: "failed",
        container_id: null,
        runtime_mode: "swarm",
        swarm_service_name: "ploydok-app-established",
        updated_at: STALE_UPDATED_AT,
      },
      idx,
      NOW
    )
    expect(next).toBe("running")
  })

  it("treats unhealthy + starting as alive (no flip from running)", async () => {
    for (const status of ["unhealthy", "starting"] as const) {
      const idx = await buildIndex([snap({ id: "ctr", appId: "app", status })])
      const next = deriveLiveStatus(
        {
          id: "app",
          status: "running",
          container_id: "ctr",
          updated_at: FRESH_UPDATED_AT,
        },
        idx,
        NOW
      )
      expect(next).toBeNull()
    }
  })

  it("does not flip running → failed during the deploy grace window", () => {
    const idx = emptyIndex()
    const next = deriveLiveStatus(
      {
        id: "app-3",
        status: "running",
        container_id: null,
        updated_at: FRESH_UPDATED_AT,
      },
      idx,
      NOW
    )
    expect(next).toBeNull()
  })

  it("flips running → failed when no container exists past grace window", () => {
    const idx = emptyIndex()
    const next = deriveLiveStatus(
      {
        id: "app-4",
        status: "running",
        container_id: null,
        updated_at: STALE_UPDATED_AT,
      },
      idx,
      NOW
    )
    expect(next).toBe("failed")
  })

  it("ignores transitional statuses (building/restarting/pending/created)", async () => {
    const idx = await buildIndex([
      snap({ id: "ctr", appId: "app", status: "stopped" }),
    ])
    for (const status of ["building", "restarting", "pending", "created"]) {
      const next = deriveLiveStatus(
        {
          id: "app",
          status,
          container_id: "ctr",
          updated_at: STALE_UPDATED_AT,
        },
        idx,
        NOW
      )
      expect(next).toBeNull()
    }
  })

  it("falls back to app_id label when container_id is missing", async () => {
    const idx = await buildIndex([
      snap({
        id: "ctr-x",
        appId: "app-5",
        status: "stopped",
        name: "ploydok-app-app-5-blue",
      }),
    ])
    const next = deriveLiveStatus(
      {
        id: "app-5",
        status: "running",
        container_id: null,
        updated_at: STALE_UPDATED_AT,
      },
      idx,
      NOW
    )
    expect(next).toBe("failed")
  })

  it("prefers running snapshot over stopped one when blue/green coexist", async () => {
    const idx = await buildIndex([
      snap({ id: "ctr-blue", appId: "app-6", status: "stopped" }),
      snap({
        id: "ctr-green",
        appId: "app-6",
        status: "running",
        name: "ploydok-app-app-6-green",
      }),
    ])
    const next = deriveLiveStatus(
      {
        id: "app-6",
        status: "failed",
        container_id: null,
        updated_at: FRESH_UPDATED_AT,
      },
      idx,
      NOW
    )
    expect(next).toBe("running")
  })

  it("returns null for stopped app when container is also stopped", async () => {
    const idx = await buildIndex([
      snap({ id: "ctr", appId: "app", status: "stopped" }),
    ])
    const next = deriveLiveStatus(
      {
        id: "app",
        status: "stopped",
        container_id: "ctr",
        updated_at: STALE_UPDATED_AT,
      },
      idx,
      NOW
    )
    expect(next).toBeNull()
  })
})

describe("reconcileAppStatusFromIndex", () => {
  it("persists status flip and returns updated row", async () => {
    const updateCalls: Array<{ id: string; status: string }> = []
    const fakeDb = {
      update: () => ({
        set: (patch: { status: string }) => ({
          where: () => {
            updateCalls.push({ id: "captured", status: patch.status })
            return Promise.resolve()
          },
        }),
      }),
    } as unknown as Db

    const idx = await buildIndex([
      snap({ id: "ctr", appId: "app-7", status: "stopped" }),
    ])

    const out = await reconcileAppStatusFromIndex(
      fakeDb,
      {
        id: "app-7",
        status: "running",
        container_id: "ctr",
        updated_at: STALE_UPDATED_AT,
      },
      idx
    )

    expect(out.status).toBe("failed")
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]?.status).toBe("failed")
  })

  it("returns row unchanged when no flip needed", async () => {
    const fakeDb = {} as Db
    const idx = await buildIndex([
      snap({ id: "ctr", appId: "app-8", status: "running" }),
    ])

    const row = {
      id: "app-8",
      status: "running",
      container_id: "ctr",
      updated_at: FRESH_UPDATED_AT,
    }
    const out = await reconcileAppStatusFromIndex(fakeDb, row, idx)
    expect(out).toBe(row)
  })

  it("does not persist container_id for Swarm apps", async () => {
    const updateCalls: Array<unknown> = []
    const fakeDb = {
      update: () => ({
        set: (patch: unknown) => {
          updateCalls.push(patch)
          return { where: () => Promise.resolve() }
        },
      }),
    } as unknown as Db

    const idx = await buildIndex([
      snap({
        id: "task-1",
        appId: "app-swarm",
        status: "running",
        name: "ploydok-app-demo-abc.1.task",
      }),
    ])

    const out = await reconcileAppStatusFromIndex(
      fakeDb,
      {
        id: "app-swarm",
        status: "running",
        container_id: null,
        runtime_mode: "swarm",
        updated_at: FRESH_UPDATED_AT,
      },
      idx
    )

    expect(out.container_id).toBeNull()
    expect(updateCalls).toHaveLength(0)
  })

  it("leaves transitional app rows to the worker", async () => {
    const updateCalls: Array<unknown> = []
    const fakeDb = {
      update: () => ({
        set: (patch: unknown) => {
          updateCalls.push(patch)
          return { where: () => Promise.resolve() }
        },
      }),
    } as unknown as Db

    const idx = await buildIndex([
      snap({ id: "ctr-building", appId: "app-building", status: "running" }),
    ])
    const row = {
      id: "app-building",
      status: "building",
      container_id: null,
      runtime_mode: "docker",
      updated_at: FRESH_UPDATED_AT,
    }

    const out = await reconcileAppStatusFromIndex(fakeDb, row, idx)

    expect(out).toBe(row)
    expect(updateCalls).toHaveLength(0)
  })
})

describe("loadAppContainerIndex", () => {
  it("returns null when agent rejects", async () => {
    const agent = {
      listContainers: mock(async () => {
        throw new Error("boom")
      }),
    } as unknown as Agent
    const idx = await loadAppContainerIndex(agent)
    expect(idx).toBeNull()
  })
})
