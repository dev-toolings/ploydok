// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { apps, builds, projects, users } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { makeTestDb, TEST_PG_URL } from "../test/db-helpers"
import { fetchRunningAppsForCaddy } from "./reconciler"

const skip = !TEST_PG_URL
if (skip) console.log("[reconciler.pg] PLOYDOK_TEST_PG_URL not set — skipping")

describe.skipIf(skip)("fetchRunningAppsForCaddy (Postgres)", () => {
  let db: Db
  let cleanup: () => Promise<void>
  const suffix = nanoid(8).toLowerCase()
  const userId = `reconcile-user-${suffix}`
  const projectId = `reconcile-project-${suffix}`
  const appId = `reconcile-app-${suffix}`
  const buildId = `reconcile-build-${suffix}`
  const service = `ploydok-app-swarm-${suffix}`

  beforeAll(async () => {
    ;({ db, cleanup } = await makeTestDb())
    const now = new Date()
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      display_name: "Reconcile Test",
      created_at: now,
      updated_at: now,
    })
    await db.insert(projects).values({
      id: projectId,
      owner_id: userId,
      name: "Reconcile Test",
      slug: projectId,
      created_at: now,
    })
    // Swarm replaced the task after the deploy: the app row now holds the new
    // task name while the build still records the service name.
    await db.insert(apps).values({
      id: appId,
      project_id: projectId,
      name: "Reconcile Test",
      slug: appId,
      status: "running",
      domain: `${appId}.demo.localhost`,
      runtime_mode: "swarm",
      swarm_service_name: service,
      container_id: `${service}.1.replacedtask`,
      created_at: now,
      updated_at: now,
    })
    await db.insert(builds).values({
      id: buildId,
      app_id: appId,
      status: "succeeded",
      runtime_ref: service,
    })
  })

  afterAll(async () => {
    await db
      .delete(users)
      .where(eq(users.id, userId))
      .catch(() => undefined)
    await cleanup()
  })

  it("finds the build of a Swarm app after its task was replaced", async () => {
    const rows = await fetchRunningAppsForCaddy(db)
    const row = rows.find((candidate) => candidate.id === appId)
    expect(row?.current_build_id).toBe(buildId)
  })
})
