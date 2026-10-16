// SPDX-License-Identifier: AGPL-3.0-only
import { eq, or, type SQL } from "drizzle-orm"
import { builds } from "@ploydok/db"

export interface RuntimeIdentity {
  container_id: string | null
  runtime_mode?: string | null
  swarm_service_name?: string | null
}

/**
 * Condition matching the builds that produced an app's running runtime, or
 * undefined when the app has no runtime. A Swarm build records its service
 * name, while the app row holds the current task name, which changes every
 * time Swarm replaces the task: match both, or the running build is lost.
 */
export function runningBuildMatch(app: RuntimeIdentity): SQL | undefined {
  if (!app.container_id) return undefined
  const service =
    app.runtime_mode === "swarm" ? app.swarm_service_name : null
  return or(
    eq(builds.container_id, app.container_id),
    eq(builds.runtime_ref, app.container_id),
    ...(service ? [eq(builds.runtime_ref, service)] : [])
  )
}
