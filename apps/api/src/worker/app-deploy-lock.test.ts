// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import type { Db } from "@ploydok/db"
import {
  DeployCancelledError,
  fenceDeploySideEffect,
  runOwnedDeployReconciliation,
  withAppDeployLease as realWithAppDeployLease,
} from "./app-deploy-lock"

// Keep lease unit tests independent of a running Redis service.
const gateRedis = { eval: mock(async () => 1) }
function withAppDeployLease<T>(
  db: Db, appId: string, buildId: string, task: () => Promise<T>,
  opts: Parameters<typeof realWithAppDeployLease>[4] = {}
) {
  return realWithAppDeployLease(db, appId, buildId, task, { gateRedis, ...opts })
}

function fakeDb(results: unknown[][]) {
  const execute = mock(async (_query: SQL) => results.shift() ?? [])
  return { db: { execute } as unknown as Db, execute }
}

describe("durable app deploy lease", () => {
  it("runs only after a token was durably acquired and releases it", async () => {
    const { db, execute } = fakeDb([
      [{ lease_token: "token-1" }],
      [{ lease_token: "token-1", cancelled: false }],
      [],
    ])
    await expect(
      withAppDeployLease(db, "app-1", "build-1", async () => "ok", {
        token: "token-1",
      })
    ).resolves.toBe("ok")
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it("cancels the second deployment with a reason before running its task", async () => {
    const { db, execute } = fakeDb([[], [{ id: "build-2" }]])
    const task = mock(async () => undefined)
    await expect(
      withAppDeployLease(db, "app-1", "build-2", task)
    ).rejects.toBeInstanceOf(DeployCancelledError)
    expect(task).not.toHaveBeenCalled()
    const update = new PgDialect().sqlToQuery(execute.mock.calls[1]![0] as SQL)
    expect(update.sql).toContain("status = 'cancelled'")
    expect(update.sql).toContain("finished_at = now()")
    expect(update.sql).toContain("status = 'pending'")
    expect(update.sql).toContain("NOT EXISTS")
    expect(update.params).toContain("build-2")
    expect(update.params[0]).toContain("another worker owns the app deployment lease")
  })

  it("cancels a pending deployment blocked by Docker cleanup", async () => {
    const { db, execute } = fakeDb([[{ id: "build-2" }]])
    const task = mock(async () => undefined)
    await expect(
      withAppDeployLease(db, "app-1", "build-2", task, {
        gateRedis: { eval: mock(async () => 0) },
      })
    ).rejects.toBeInstanceOf(DeployCancelledError)
    expect(task).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    const update = new PgDialect().sqlToQuery(execute.mock.calls[0]![0] as SQL)
    expect(update.sql).toContain("status = 'cancelled'")
    expect(update.sql).toContain("finished_at = now()")
    expect(update.params[0]).toContain("Docker cleanup owns the build lifecycle gate")
  })

  it("stops at the next fence after cancellation intent", async () => {
    const { db, execute } = fakeDb([])
    let calls = 0
    execute.mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        return [{ lease_token: "token-1" }]
      }
      if (calls === 2) return [{ lease_token: "owned", cancelled: false }]
      if (calls === 3) return [{ lease_token: "owned", cancelled: true }]
      return []
    })
    await expect(
      withAppDeployLease(
        db,
        "app-1",
        "build-1",
        async () => {
          await fenceDeploySideEffect()
        },
        { token: "token-1" }
      )
    ).rejects.toBeInstanceOf(DeployCancelledError)
  })

  it("does not run stale cleanup after a successor replaced the token", async () => {
    const { db } = fakeDb([
      [{ lease_token: "stale-token" }],
      [{ lease_token: "stale-token", cancelled: false }],
      [],
      [],
    ])
    const cleanup = mock(async () => undefined)
    await withAppDeployLease(
      db,
      "app-1",
      "build-stale",
      async () => {
        await expect(runOwnedDeployReconciliation(cleanup)).resolves.toBe(false)
      },
      { token: "stale-token" }
    )
    expect(cleanup).not.toHaveBeenCalled()
  })

  it("allows cancellation cleanup while the exact token is still owner", async () => {
    const { db } = fakeDb([
      [{ lease_token: "cancel-token" }],
      [{ lease_token: "cancel-token", cancelled: false }],
      [{ owned: true }],
      [],
    ])
    const cleanup = mock(async () => undefined)
    await withAppDeployLease(
      db,
      "app-1",
      "build-cancelled",
      async () => {
        await expect(runOwnedDeployReconciliation(cleanup)).resolves.toBe(true)
      },
      { token: "cancel-token" }
    )
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
