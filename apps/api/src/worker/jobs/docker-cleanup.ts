// SPDX-License-Identifier: AGPL-3.0-only
import { nanoid } from "nanoid"
import type { Queue } from "bullmq"
import { system_jobs } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { enqueueWithDbRow } from "../queue-enqueue"

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const HOUR_UTC = 23
const MINUTE_UTC = 50
let timer: ReturnType<typeof setTimeout> | null = null
let interval: ReturnType<typeof setInterval> | null = null
let ticking = false

export async function enqueueDockerCleanup(
  db: Db,
  queue: Queue,
  source: "api" | "cron:gc" = "cron:gc"
): Promise<string> {
  const { row } = await enqueueWithDbRow({
    db,
    queue,
    jobName: "gc.docker.requested",
    insertRow: (tx) =>
      tx
        .insert(system_jobs)
        .values({ id: nanoid(), kind: "gc.docker", source, options: {} })
        .returning()
        .then((rows: (typeof system_jobs.$inferSelect)[]) => rows[0]!),
    buildPayload: (row) => ({ jobId: row.id }),
  })
  return row.id
}

function delayUntil2350Utc(now = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), HOUR_UTC, MINUTE_UTC))
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

export function startDockerCleanupCron(opts: { db: Db; queue: Queue; now?: () => Date }): void {
  stopDockerCleanupCron()
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      await enqueueDockerCleanup(opts.db, opts.queue)
    } finally {
      ticking = false
    }
  }
  timer = setTimeout(() => {
    void tick()
    interval = setInterval(() => void tick(), ONE_DAY_MS)
  }, delayUntil2350Utc(opts.now?.()))
}

export function isDockerCleanupScheduleEnabled(enabled: boolean): boolean {
  return enabled
}

export function stopDockerCleanupCron(): void {
  if (timer) clearTimeout(timer)
  if (interval) clearInterval(interval)
  timer = null
  interval = null
  ticking = false
}

export { delayUntil2350Utc }
