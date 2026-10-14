// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from "@ploydok/db"
import {
  listExpiredPreviews,
} from "@ploydok/db/queries"
import { enqueuePreviewIntent } from "../preview-intents"
import { previewTeardown } from "../queues"
import { workerLog } from "../logger"

const log = workerLog.child({ subsystem: "cleanup-previews" })

const ONE_HOUR_MS = 60 * 60 * 1000

let _cronTimer: ReturnType<typeof setTimeout> | null = null
let _cronInterval: ReturnType<typeof setInterval> | null = null

/**
 * Periodic cleanup: find expired preview deployments and enqueue teardown.
 */
export async function cleanupExpiredPreviews(db: Db): Promise<void> {
  try {
    log.debug("starting expired preview cleanup")

    const expired = await listExpiredPreviews(db)
    log.debug({ count: expired.length }, "found expired previews")

    for (const preview of expired) {
      log.info(
        { previewId: preview.id, appId: preview.app_id },
        "enqueuing teardown"
      )
      await enqueuePreviewIntent(db, previewTeardown, {
        action: "teardown", appId: preview.app_id, prNumber: preview.pr_number,
        source: "cron:preview",
      })
    }

    log.debug({ count: expired.length }, "cleanup complete")
  } catch (error) {
    log.error({ error }, "failed to cleanup expired previews")
  }
}

/**
 * Start the preview cleanup cron. Runs every 1 hour.
 */
export function startCleanupPreviewsCron(db: Db): void {
  stopCleanupPreviewsCron()

  async function tick(): Promise<void> {
    await cleanupExpiredPreviews(db)
  }

  log.info("cron scheduled — runs every 1 hour")

  _cronInterval = setInterval(() => void tick(), ONE_HOUR_MS)
  void tick()
}

/**
 * Cancel the preview cleanup cron.
 */
export function stopCleanupPreviewsCron(): void {
  if (_cronTimer !== null) {
    clearTimeout(_cronTimer)
    _cronTimer = null
  }
  if (_cronInterval !== null) {
    clearInterval(_cronInterval)
    _cronInterval = null
  }
}
