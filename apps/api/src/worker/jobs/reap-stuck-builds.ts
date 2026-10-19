// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, lt, or } from "drizzle-orm"
import { apps, builds } from "@ploydok/db"
import { updateBuildStatus } from "@ploydok/db/queries"
import type { Db } from "@ploydok/db"
import { childLogger } from "../../logger"

const log = childLogger("reap.stuck-builds")

const STUCK_THRESHOLD_MS = 30 * 60 * 1000
const TICK_MS = 5 * 60 * 1000

let _timer: ReturnType<typeof setInterval> | null = null

async function repairAppStatusAfterReap(db: Db, appId: string): Promise<void> {
  const activeBuilds = await db
    .select({ id: builds.id })
    .from(builds)
    .where(
      and(
        eq(builds.app_id, appId),
        or(eq(builds.status, "pending"), eq(builds.status, "running"))
      )
    )
    .limit(1)

  if (activeBuilds.length > 0) return

  const appRows = await db
    .select({
      status: apps.status,
      container_id: apps.container_id,
      swarm_service_name: apps.swarm_service_name,
    })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1)
  const app = appRows[0]
  if (!app || app.status !== "building") return

  await db
    .update(apps)
    .set({
      status: app.container_id || app.swarm_service_name ? "running" : "failed",
      updated_at: new Date(),
    })
    .where(eq(apps.id, appId))
}

/**
 * Finds running builds whose started_at is older than STUCK_THRESHOLD_MS
 * and marks them cancelled. Pending builds are owned by the queue-aware
 * reconciliation in queue-deploy-reconciliation.ts, so delayed deployments
 * are never cancelled just because they have waited a long time. Covers the
 * edge case where a deploy worker crashed / was restarted mid-flight and
 * left a build row stuck in "running" with no process driving it anywhere.
 * Without this, the UI shows a perpetually spinning deployment and the
 * user has no way to unstick the app.
 */
export async function reapStuckBuilds(db: Db): Promise<{ reaped: string[] }> {
  const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS)
  const candidates = await db
    .select({ id: builds.id, app_id: builds.app_id, status: builds.status })
    .from(builds)
    .where(and(lt(builds.started_at, threshold), eq(builds.status, "running")))

  const reaped: string[] = []
  for (const row of candidates) {
    await updateBuildStatus(db, row.id, "cancelled", {
      finishedAt: new Date(),
      errorMessage:
        "Build reaped: stuck in `running` for > 30 min (worker likely crashed or was restarted mid-deploy).",
    })
    await repairAppStatusAfterReap(db, row.app_id)
    reaped.push(row.id)
  }

  if (reaped.length > 0) {
    log.info({ reaped }, "reaped stuck builds")
  }
  return { reaped }
}

export function startReapStuckBuildsCron(db: Db): void {
  stopReapStuckBuildsCron()
  // Run once immediately on boot: handles the common "dev `make dev`
  // restart left a running build stuck forever" scenario.
  void reapStuckBuilds(db).catch((err) => {
    log.error({ err }, "initial reap failed")
  })
  _timer = setInterval(() => {
    void reapStuckBuilds(db).catch((err) => {
      log.error({ err }, "reap tick failed")
    })
  }, TICK_MS)
  log.info(
    { intervalMin: TICK_MS / 60_000 },
    "reap stuck builds cron scheduled"
  )
}

export function stopReapStuckBuildsCron(): void {
  if (_timer !== null) {
    clearInterval(_timer)
    _timer = null
  }
}
