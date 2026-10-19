// SPDX-License-Identifier: AGPL-3.0-only
import { recordHostDiskSample } from "@ploydok/db/queries"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"
import { logAgentDependentFailure } from "../agent/availability"
import { diskHostKey } from "./host-key"
import type { Db } from "@ploydok/db"
import type { DiskSample, DiskInsightsResponse } from "@ploydok/shared"

const log = childLogger("disk.history")
let timer: ReturnType<typeof setInterval> | null = null
let running = false

export async function sampleHostDisk(db: Db): Promise<void> {
  const stats = await getSharedAgent().hostStats({}, 2_000)
  if (stats.diskTotalBytes <= 0 || stats.error.includes("disk:")) return
  await recordHostDiskSample(
    db,
    diskHostKey,
    new Date(),
    stats.diskUsedBytes,
    stats.diskTotalBytes
  )
}

export function startDiskHistorySampler(db: Db): void {
  stopDiskHistorySampler()
  const tick = async () => {
    if (running) return
    running = true
    try {
      await sampleHostDisk(db)
    } catch (err) {
      logAgentDependentFailure(log, err, {}, "disk history sample failed")
    } finally {
      running = false
    }
  }
  void tick()
  timer = setInterval(() => {
    void tick()
  }, 3_600_000)
}

export function stopDiskHistorySampler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function diskGrowth(
  history: Array<DiskSample>,
  now = Date.now()
): Pick<DiskInsightsResponse, "growth7dBytes" | "daysTo90Percent"> {
  const newest = history.at(-1)
  const target = now - 7 * 86_400_000
  const baseline = [...history]
    .reverse()
    .find((sample) => Date.parse(sample.measuredAt) <= target)
  if (
    !newest ||
    !baseline ||
    now - Date.parse(newest.measuredAt) > 2 * 3_600_000 ||
    target - Date.parse(baseline.measuredAt) > 6 * 3_600_000 ||
    newest.totalBytes !== baseline.totalBytes
  ) {
    return { growth7dBytes: null, daysTo90Percent: null }
  }
  const growth7dBytes = newest.usedBytes - baseline.usedBytes
  const elapsedDays =
    (Date.parse(newest.measuredAt) - Date.parse(baseline.measuredAt)) /
    86_400_000
  const remaining = newest.totalBytes * 0.9 - newest.usedBytes
  return {
    growth7dBytes,
    daysTo90Percent:
      remaining <= 0
        ? 0
        : growth7dBytes > 0 && elapsedDays > 0
          ? remaining / (growth7dBytes / elapsedDays)
          : null,
  }
}
