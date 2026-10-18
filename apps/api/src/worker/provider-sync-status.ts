// SPDX-License-Identifier: AGPL-3.0-only
import { createRedis } from "@ploydok/db"
import { env } from "../env"

let redis: ReturnType<typeof createRedis> | undefined
function connection(): ReturnType<typeof createRedis> {
  return (redis ??= createRedis(env.REDIS_URL))
}

export interface SyncTargetStatus {
  status: "running" | "done" | "error"
  totalRepos?: number
  error?: string
}

// Scope receipts to the requesting user, independently of notification replay.
// Keep them for one day so install redirects and API restarts can reconcile.
function receiptKey(userId: string, syncId: string): string {
  return `ploydok:provider-sync:${userId}:${syncId}`
}

export async function writeSyncTargetStatus(
  userId: string,
  syncId: string,
  target: string,
  status: SyncTargetStatus
): Promise<void> {
  const results = await connection()
    .multi()
    .hset(receiptKey(userId, syncId), target, JSON.stringify(status))
    .expire(receiptKey(userId, syncId), 86_400)
    .exec()
  for (const [error] of results ?? []) {
    if (error) throw error
  }
}

export function summarizeSyncTargets(
  targets: SyncTargetStatus[]
): SyncTargetStatus | null {
  if (targets.length === 0) return null
  const failed = targets.find((target) => target.status === "error")
  return {
    status: failed
      ? "error"
      : targets.every((target) => target.status === "done")
        ? "done"
        : "running",
    totalRepos: targets.reduce(
      (total, target) => total + (target.totalRepos ?? 0),
      0
    ),
    ...(failed?.error !== undefined ? { error: failed.error } : {}),
  }
}

export async function readSyncStatus(
  userId: string,
  syncId: string
): Promise<SyncTargetStatus | null> {
  const entries = await connection().hgetall(receiptKey(userId, syncId))
  return summarizeSyncTargets(
    Object.values(entries).map((entry) => JSON.parse(entry) as SyncTargetStatus)
  )
}
