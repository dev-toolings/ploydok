// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm"
import type { Db } from "@ploydok/db"

export interface DeployQueueInspector {
  getJob(id: string): Promise<{ getState(): Promise<string> } | undefined | null>
}

const ORPHAN_AGE_MS = 5 * 60_000

/** Publication is the outbox's boundary. Repair pending builds abandoned later. */
export async function reconcileOrphanedPendingDeploys(
  db: Db,
  queue: DeployQueueInspector,
  now = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - ORPHAN_AGE_MS)
  const eligible = sql`
    builds.status = 'pending' AND builds.queued_at < ${cutoff}
    AND NOT EXISTS (
      SELECT 1 FROM app_deploy_leases lease
      WHERE lease.build_id = builds.id AND lease.lease_until > now()
    )
    AND NOT EXISTS (
      SELECT 1 FROM queue_outbox_events event
      WHERE event.queue_name = 'deploy' AND event.source_row_id = builds.id
        AND (event.dispatched_at IS NULL OR event.dispatched_at >= ${cutoff})
    )
  `
  const candidates = await db.execute(sql`
    SELECT builds.id FROM builds WHERE ${eligible}
  `) as unknown as { id: string }[]
  let resolved = 0
  for (const { id } of candidates) {
    // A Redis error or an unrecognized state is not evidence of an orphan. Waiting,
    // delayed, active, paused and dependency-blocked jobs all remain queued.
    const job = await queue.getJob(id)
    const state = job ? await job.getState() : "missing"
    if (!["missing", "unknown", "failed", "completed"].includes(state)) continue
    // BullMQ's `unknown` means the inspected job was removed in the meantime.
    // Recheck SQL guards so a worker claim or new outbox intent wins the race.
    const rows = await db.execute(sql`
      UPDATE builds SET status = 'failed', finished_at = ${now},
        error_message = ${`Deployment queue reconciliation: no live deploy job (${state}) for a pending build older than 5 minutes. Request a new deployment.`}
      WHERE builds.id = ${id} AND ${eligible}
      RETURNING builds.id
    `) as unknown as { id: string }[]
    resolved += rows.length
  }
  return resolved
}
