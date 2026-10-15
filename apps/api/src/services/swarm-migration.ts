// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, isNotNull } from "drizzle-orm"
import { apps, builds, type Db } from "@ploydok/db"
import { runSwarmDeploy, loadRuntimeEnv } from "../worker/swarm-runner.js"
import { stopContainer } from "../worker/runner.js"
import { createAgentClient } from "../agent/client.js"
import { childLogger } from "../logger.js"

const log = childLogger("swarm-migration")

export async function migrateDockerAppsToSwarmOnBoot(db: Db): Promise<{
  attempted: number
  migrated: number
  skipped: number
  failed: number
}> {
  const rows = await db
    .select({
      id: apps.id,
      container_id: apps.container_id,
      runtime_port: apps.runtime_port,
    })
    .from(apps)
    .where(
      and(
        eq(apps.runtime_mode, "docker"),
        eq(apps.status, "running"),
        isNotNull(apps.container_id)
      )
    )

  const result = { attempted: rows.length, migrated: 0, skipped: 0, failed: 0 }
  for (const app of rows) {
    const latest = await db
      .select({ image_tag: builds.image_tag })
      .from(builds)
      .where(and(eq(builds.app_id, app.id), eq(builds.status, "succeeded")))
      .orderBy(desc(builds.created_at))
      .limit(1)
    const imageRef = latest[0]?.image_tag
    if (!imageRef) {
      result.skipped++
      continue
    }
    try {
      const runtimeEnv = await loadRuntimeEnv(db, app.id)
      const deployed = await runSwarmDeploy({
        appId: app.id,
        imageRef,
        env: runtimeEnv,
        db,
        ...(app.runtime_port ? { runtimePort: app.runtime_port } : {}),
      })
      if (app.container_id && deployed.routeApplied) {
        const agent = createAgentClient()
        try {
          await stopContainer(agent, app.container_id)
        } finally {
          agent.close()
        }
      }
      result.migrated++
    } catch (err) {
      result.failed++
      log.warn({ err, appId: app.id }, "docker to swarm migration failed")
    }
  }
  return result
}
