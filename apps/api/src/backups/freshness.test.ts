// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test"
import {
  INVALID_BACKUP_SCHEDULE_MAX_AGE_SECONDS,
  backupAgeSeconds,
  backupFreshnessKey,
  backupMaxAgeSeconds,
  backupIsStale,
  timestampSeconds,
} from "./freshness"

describe("backup freshness calculations", () => {
  test("derives hourly and weekly thresholds from their schedule intervals", () => {
    expect(INVALID_BACKUP_SCHEDULE_MAX_AGE_SECONDS).toBe(24 * 60 * 60)
    const anchor = new Date("2026-10-15T12:00:00.000Z")
    expect(backupMaxAgeSeconds("0 * * * *", anchor)).toBe(5_430)
    expect(backupMaxAgeSeconds("0 3 * * 0", anchor)).toBe(907_230)

    const now = new Date("2026-10-15T12:00:00.000Z")
    expect(backupAgeSeconds(now, new Date("2026-10-14T12:00:01.000Z"))).toBe(
      86_399
    )
    expect(backupAgeSeconds(now, null)).toBe(0)
  })

  test("marks a never-successful config stale after its schedule threshold", () => {
    expect(timestampSeconds(null)).toBe(0)
    expect(timestampSeconds("not-a-timestamp")).toBe(0)
    const now = new Date("2026-10-15T12:00:00.000Z")
    const configuredAt = new Date("2026-10-15T10:29:30.000Z")
    const row = {
      schedule_cron: "0 * * * *",
      configured_at: configuredAt,
      last_success_at: null,
    }
    expect(backupIsStale(row, now)).toBe(false)
    expect(
      backupIsStale(
        { ...row, configured_at: new Date(configuredAt.getTime() - 1_000) },
        now
      )
    ).toBe(true)
    expect(
      backupFreshnessKey({ resource_type: "database", config_id: "cfg-1" })
    ).toBe("database:cfg-1")
  })
})
