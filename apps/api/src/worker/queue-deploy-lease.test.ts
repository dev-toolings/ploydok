// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { DelayedError } from "bullmq"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import type { Db } from "@ploydok/db"
import { DeployCancelledError } from "./app-deploy-lock"
import { runQueuedDeployWithLease } from "./queue-deploy-lease"

// Stateful SQL adapter: exercise the real lease entry and BullMQ control path
// without an external Redis/Postgres service. The PG suite covers real SQL.
function harness() {
  type Build = { id: string; order: number; status: string; reason: string | null; finished: boolean }
  const builds = new Map<string, Build>()
  let lease: { buildId: string; token: string } | null = null
  let gateOpen = true
  const dialect = new PgDialect()
  const execute = mock(async (query: SQL): Promise<unknown[]> => {
    const compiled = dialect.sqlToQuery(query)
    const text = compiled.sql.replace(/\s+/g, " ")
    const param = (index: number): string => {
      const value = compiled.params[index]
      if (typeof value !== "string") throw new Error(`Expected string SQL parameter ${index}`)
      return value
    }
    if (text.includes("pg_advisory_xact_lock")) return []
    if (text.includes("SELECT status, error_message")) {
      const row = builds.get(param(0))
      return row ? [{ status: row.status, error_message: row.reason }] : []
    }
    if (text.includes("SELECT waiting.id")) {
      expect(text).toContain("ORDER BY waiting.queued_at DESC, waiting.created_at DESC, waiting.id DESC")
      const newest = [...builds.values()].filter((b) => b.status === "pending" && b.id !== lease?.buildId)
        .sort((a, b) => b.order - a.order)[0]
      return newest ? [{ id: newest.id }] : []
    }
    if (text.includes("UPDATE builds SET status = 'cancelled'")) {
      expect(text).toContain("lease.build_id = builds.id")
      expect(text).toContain("lease.lease_until > now()")
      expect(text).toContain("(builds.queued_at, builds.created_at, builds.id) <")
      for (const row of builds.values()) {
        if (row.status === "pending" && row.order < builds.get(param(2))!.order && row.id !== lease?.buildId) {
          row.status = "cancelled"
          row.reason = param(0)
          row.finished = true
        }
      }
      return []
    }
    if (text.includes("SELECT true AS owned")) return lease?.buildId === param(0) ? [{ owned: true }] : []
    if (text.includes("INSERT INTO app_deploy_leases")) {
      if (lease) return []
      lease = { buildId: param(1), token: param(2) }
      return [{ lease_token: param(2) }]
    }
    if (text.includes("UPDATE builds SET error_message = NULL")) {
      const row = builds.get(param(0))!
      if (row.reason?.startsWith("Deployment queued:")) row.reason = null
      return []
    }
    if (text.includes("UPDATE builds SET error_message =")) {
      const row = builds.get(param(1))!
      if (row.status === "pending" && row.id !== lease?.buildId) row.reason = param(0)
      return []
    }
    if (text.includes("UPDATE app_deploy_leases AS lease")) {
      return lease ? [{ lease_token: lease.token, cancelled: builds.get(lease.buildId)?.status === "cancelled" }] : []
    }
    if (text.includes("DELETE FROM app_deploy_leases")) {
      if (lease?.token === param(1)) lease = null
      return []
    }
    throw new Error(`Unexpected SQL: ${text}`)
  })
  const db = { execute, transaction: async (action: (tx: unknown) => Promise<unknown>) => action({ execute }) } as unknown as Db
  function add(id: string) {
    const row: Build = { id, order: builds.size, status: "pending", reason: null, finished: false }
    builds.set(id, row)
    const job = {
      attemptsMade: 0, opts: { attempts: 1 }, state: "active",
      moveToDelayed: mock(async (_timestamp: number, token?: string) => {
        expect(token).toBe("bull-token")
        job.state = "delayed"
      }),
    }
    return {
      row, job,
      run: (task: () => Promise<void>) => runQueuedDeployWithLease(db, "app", id, task, job, "bull-token", {
        token: `lease-${id}`, gateRedis: { eval: async () => gateOpen ? 1 : 0 },
      }),
    }
  }
  return { add, setGate: (open: boolean) => { gateOpen = open } }
}

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe("queued deployment leases", () => {
  it("defers then executes after the active build without burning attempts", async () => {
    const h = harness()
    const active = h.add("active")
    const started = latch(), finish = latch()
    const first = active.run(async () => {
      active.row.status = "running"
      started.release()
      await finish.promise
      active.row.status = "succeeded"
    })
    await started.promise
    const next = h.add("next")
    const task = mock(async () => { next.row.status = "succeeded" })
    await expect(next.run(task)).rejects.toBeInstanceOf(DelayedError)
    expect(task).not.toHaveBeenCalled()
    expect(next.row.status).toBe("pending")
    expect(next.row.reason).toContain("waiting for the active app deployment")
    expect(next.job.state).toBe("delayed")
    expect(next.job.attemptsMade).toBe(0)
    finish.release()
    await first
    await next.run(task)
    expect(task).toHaveBeenCalledTimes(1)
    expect(next.row.status).toBe("succeeded")
    expect(next.row.reason).toBeNull()
  })

  it("runs only the newest waiting build and identifies the superseding request", async () => {
    const h = harness()
    const active = h.add("active")
    const started = latch(), finish = latch()
    const first = active.run(async () => {
      // Keep the row pending to exercise the pre-claim ownership guard.
      started.release()
      await finish.promise
      active.row.status = "succeeded"
    })
    await started.promise
    const older = h.add("older"), oldTask = mock(async () => {})
    await expect(older.run(oldTask)).rejects.toBeInstanceOf(DelayedError)
    const newest = h.add("newest"), newTask = mock(async () => { newest.row.status = "succeeded" })
    await expect(newest.run(newTask)).rejects.toBeInstanceOf(DelayedError)
    expect(older.row.status).toBe("cancelled")
    expect(older.row.reason).toBe("superseded by a newer deploy request newest")
    expect(older.row.finished).toBe(true)
    expect(active.row.status).toBe("pending")
    expect(active.row.reason).toBeNull()
    finish.release()
    await first
    await expect(older.run(oldTask)).rejects.toBeInstanceOf(DeployCancelledError)
    await newest.run(newTask)
    expect(oldTask).not.toHaveBeenCalled()
    expect(newTask).toHaveBeenCalledTimes(1)
    expect(newest.row.status).toBe("succeeded")
  })

  it("defers through the Docker cleanup gate then executes after cleanup", async () => {
    const h = harness(), next = h.add("next")
    h.setGate(false)
    const task = mock(async () => { next.row.status = "succeeded" })
    await expect(next.run(task)).rejects.toBeInstanceOf(DelayedError)
    expect(next.row.status).toBe("pending")
    expect(next.row.reason).toContain("waiting for Docker cleanup")
    expect(next.job.state).toBe("delayed")
    expect(next.job.attemptsMade).toBe(0)
    expect(task).not.toHaveBeenCalled()
    h.setGate(true)
    await next.run(task)
    expect(next.row.status).toBe("succeeded")
    expect(next.row.reason).toBeNull()
    expect(task).toHaveBeenCalledTimes(1)
  })
})
