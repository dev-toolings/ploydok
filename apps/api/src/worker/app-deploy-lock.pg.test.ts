// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { apps, builds, projects, users } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { requestBuildCancellation } from "@ploydok/db/queries"
import { makeTestDb, TEST_PG_URL } from "../test/db-helpers"
import {
  DeployCancelledError,
  DeployLeaseLostError,
  DeployDeferredError,
  fenceDeploySideEffect,
  runOwnedDeployReconciliation,
  withAppDeployLease,
} from "./app-deploy-lock"

const skip = !TEST_PG_URL
if (skip)
  console.log("[app-deploy-lock.pg] PLOYDOK_TEST_PG_URL not set: skipping")

describe.skipIf(skip)("durable deploy leases (Postgres)", () => {
  let db: Db
  let cleanup: () => Promise<void>
  const suffix = nanoid(8)
  const userId = `lease-user-${suffix}`
  const projectId = `lease-project-${suffix}`
  const appId = `lease-app-${suffix}`
  const build1 = `lease-build-1-${suffix}`
  const build2 = `lease-build-2-${suffix}`

  beforeAll(async () => {
    ;({ db, cleanup } = await makeTestDb())
    const now = new Date()
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      display_name: "Lease Test",
      created_at: now,
      updated_at: now,
    })
    await db.insert(projects).values({
      id: projectId,
      owner_id: userId,
      name: "Lease Test",
      slug: projectId,
      created_at: now,
    })
    await db.insert(apps).values({
      id: appId,
      project_id: projectId,
      name: "Lease Test",
      slug: appId,
      created_at: now,
      updated_at: now,
    })
    await db.insert(builds).values({ id: build1, app_id: appId })
  })

  afterAll(async () => {
    await db
      .delete(users)
      .where(eq(users.id, userId))
      .catch(() => undefined)
    await cleanup()
  })

  it("defers a second build until the active deployment releases its lease", async () => {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    const first = withAppDeployLease(db, appId, build1, async () => {
      started()
      await gate
      await db.update(builds).set({ status: "succeeded" }).where(eq(builds.id, build1))
    }, { token: "worker-one" })
    await entered
    await db.insert(builds).values({ id: build2, app_id: appId })
    await expect(
      withAppDeployLease(db, appId, build1, async () => undefined)
    ).rejects.toBeInstanceOf(DeployDeferredError)
    const [active] = await db.select().from(builds).where(eq(builds.id, build1))
    expect(active?.status).toBe("pending")
    expect(active?.finished_at).toBeNull()
    await expect(
      withAppDeployLease(db, appId, build2, async () => undefined)
    ).rejects.toBeInstanceOf(DeployDeferredError)
    const [waiting] = await db.select().from(builds).where(eq(builds.id, build2))
    expect(waiting?.status).toBe("pending")
    expect(waiting?.finished_at).toBeNull()
    expect(waiting?.error_message).toContain("waiting for the active app deployment")
    release()
    await first
    await withAppDeployLease(db, appId, build2, async () => {
      await db.update(builds).set({ status: "succeeded" }).where(eq(builds.id, build2))
    })
    const [executed] = await db.select().from(builds).where(eq(builds.id, build2))
    expect(executed?.status).toBe("succeeded")
    expect(executed?.error_message).toBeNull()
  })

  it("reclaims an expired lease and fences the stale owner", async () => {
    await db.update(builds)
      .set({ status: "pending", finished_at: null, error_message: null })
      .where(eq(builds.id, build1))
    let checkStale!: () => void
    const checkGate = new Promise<void>((resolve) => {
      checkStale = resolve
    })
    const stale = withAppDeployLease(
      db,
      appId,
      build1,
      async () => {
        await checkGate
        let cleaned = false
        await expect(
          runOwnedDeployReconciliation(async () => {
            cleaned = true
          })
        ).resolves.toBe(false)
        expect(cleaned).toBe(false)
        await fenceDeploySideEffect()
      },
      { token: "stale", leaseMs: 25, heartbeatMs: 60_000 }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    let releaseSuccessor!: () => void
    const successorGate = new Promise<void>((resolve) => {
      releaseSuccessor = resolve
    })
    await db.update(builds).set({ status: "pending" }).where(eq(builds.id, build2))
    const successor = withAppDeployLease(
      db,
      appId,
      build2,
      () => successorGate,
      {
        token: "successor",
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    checkStale()
    await expect(stale).rejects.toBeInstanceOf(DeployLeaseLostError)
    releaseSuccessor()
    await successor
  })

  it("observes persisted cancellation at the next fence", async () => {
    await db
      .update(builds)
      .set({ status: "running", cancel_requested_at: null })
      .where(eq(builds.id, build1))
    await expect(
      withAppDeployLease(
        db,
        appId,
        build1,
        async () => {
          const cancelled = await requestBuildCancellation(db, {
            buildId: build1,
            appId,
            requestedByUserId: userId,
            reason: "integration cancellation",
          })
          expect(cancelled?.cancel_requested_at).toBeInstanceOf(Date)
          await fenceDeploySideEffect()
        },
        { token: "cancelled-worker" }
      )
    ).rejects.toBeInstanceOf(DeployCancelledError)
  })
})
