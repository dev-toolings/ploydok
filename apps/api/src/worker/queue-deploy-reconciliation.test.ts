// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import type { Db } from "@ploydok/db"
import { reconcileOrphanedPendingDeploys } from "./queue-deploy-reconciliation"

const now = new Date("2026-10-19T12:00:00Z")
const dialect = new PgDialect()

describe("pending deploy reconciliation", () => {
  it("resolves old orphans, preserves live jobs and rechecks durable ownership", async () => {
    const states: Record<string, string | null> = {
      absent: null, failed: "failed", completed: "completed", removed: "unknown",
      active: "active", waiting: "waiting", delayed: "delayed", paused: "paused",
      blocked: "waiting-children", futureState: "unrecognized",
    }
    const execute = mock(async (query: SQL) => {
      const { sql } = dialect.sqlToQuery(query)
      return sql.includes("SELECT builds.id FROM builds")
        ? Object.keys(states).map((id) => ({ id }))
        : [{ id: "resolved" }]
    })
    const getJob = mock(async (id: string) => states[id] === null
      ? undefined : { getState: async () => states[id]! })
    expect(await reconcileOrphanedPendingDeploys(
      { execute } as unknown as Db, { getJob }, now
    )).toBe(4)
    expect(execute).toHaveBeenCalledTimes(5)
    for (const [query] of execute.mock.calls) {
      const compiled = dialect.sqlToQuery(query)
      expect(compiled.sql).toContain("builds.status = 'pending'")
      expect(compiled.sql).toContain("builds.queued_at <")
      expect(compiled.params).toContainEqual(new Date("2026-10-19T11:55:00Z"))
      expect(compiled.sql).toContain("lease.build_id = builds.id")
      expect(compiled.sql).toContain("lease.lease_until > now()")
      expect(compiled.sql).toContain("event.dispatched_at IS NULL")
      expect(compiled.sql).toContain("event.dispatched_at >=")
    }
    const update = dialect.sqlToQuery(execute.mock.calls[1]![0])
    expect(update.sql).toContain("status = 'failed'")
    expect(update.sql).toContain("finished_at =")
    expect(update.params).toContainEqual(expect.stringContaining("no live deploy job"))
  })

  it("leaves pending builds intact when Redis cannot establish job state", async () => {
    const execute = mock(async (_query: SQL) => [{ id: "build" }])
    await expect(reconcileOrphanedPendingDeploys(
      { execute } as unknown as Db,
      { getJob: async () => { throw new Error("Redis unavailable") } }, now
    )).rejects.toThrow("Redis unavailable")
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("does not resolve a build claimed between the scan and terminal write", async () => {
    const execute = mock(async (query: SQL) =>
      dialect.sqlToQuery(query).sql.includes("SELECT builds.id FROM builds")
        ? [{ id: "claimed-in-meantime" }] : [])
    expect(await reconcileOrphanedPendingDeploys(
      { execute } as unknown as Db, { getJob: async () => undefined }, now
    )).toBe(0)
  })
})
