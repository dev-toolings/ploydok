// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test"
import {
  INVALID_BACKUP_SCHEDULE_FALLBACK_SECONDS,
  backupAgeSeconds,
  backupDeadlineTimestampSeconds,
  backupFreshnessKey,
  backupIsStale,
  timestampSeconds,
} from "./freshness"

describe("backup freshness calculations", () => {
  test("derives hourly and weekly deadlines from the next two occurrences", () => {
    const hourlyDeadline = backupDeadlineTimestampSeconds({
      schedule_cron: "0 * * * *",
      configured_at: new Date("2026-10-01T00:00:00.000Z"),
      last_success_at: new Date("2026-10-15T03:59:59.999Z"),
    })
    expect(new Date((hourlyDeadline ?? 0) * 1_000).toISOString()).toBe(
      "2026-10-15T04:30:00.000Z"
    )

    const weeklyDeadline = backupDeadlineTimestampSeconds({
      schedule_cron: "0 3 * * 0",
      configured_at: new Date("2026-10-01T00:00:00.000Z"),
      last_success_at: new Date("2026-10-12T03:00:00.000Z"),
    })
    expect(new Date((weeklyDeadline ?? 0) * 1_000).toISOString()).toBe(
      "2026-10-21T15:00:00.000Z"
    )

    const now = new Date("2026-10-15T12:00:00.000Z")
    expect(backupAgeSeconds(now, new Date("2026-10-14T12:00:01.000Z"))).toBe(
      86_399
    )
    expect(backupAgeSeconds(now, null)).toBe(0)
  })

  test("uses the configured time for a never-successful config", () => {
    expect(timestampSeconds(null)).toBe(0)
    expect(timestampSeconds("not-a-timestamp")).toBe(0)
    const configuredAt = new Date("2026-10-15T10:29:30.000Z")
    const row = {
      schedule_cron: "0 * * * *",
      configured_at: configuredAt,
      last_success_at: null,
    }
    const deadline = backupDeadlineTimestampSeconds(row)
    expect(new Date((deadline ?? 0) * 1_000).toISOString()).toBe(
      "2026-10-15T11:30:00.000Z"
    )
    expect(
      backupIsStale(
        row,
        new Date("2026-10-15T11:30:00.000Z")
      )
    ).toBe(false)
    expect(
      backupIsStale(row, new Date("2026-10-15T11:30:01.000Z"))
    ).toBe(true)
    expect(
      backupFreshnessKey({ resource_type: "database", config_id: "cfg-1" })
    ).toBe("database:cfg-1")
  })

  test("uses a one-day fallback for an invalid cron expression", () => {
    expect(INVALID_BACKUP_SCHEDULE_FALLBACK_SECONDS).toBe(24 * 60 * 60)
    const configuredAt = new Date("2026-10-15T10:29:30.000Z")
    const deadline = backupDeadlineTimestampSeconds({
      schedule_cron: "not a cron",
      configured_at: configuredAt,
      last_success_at: null,
    })
    expect(new Date((deadline ?? 0) * 1_000).toISOString()).toBe(
      "2026-10-16T10:29:30.000Z"
    )
  })

  test("derives irregular month intervals from the actual next occurrences", () => {
    const deadline = backupDeadlineTimestampSeconds({
      schedule_cron: "0 3 1,15 * *",
      configured_at: new Date("2025-12-01T00:00:00.000Z"),
      last_success_at: new Date("2026-01-01T04:00:00.000Z"),
    })
    expect(new Date((deadline ?? 0) * 1_000).toISOString()).toBe(
      "2026-01-23T15:00:00.000Z"
    )
  })

  test("keeps the scheduler tolerance floor for second-based cron", () => {
    const deadline = backupDeadlineTimestampSeconds({
      schedule_cron: "* * * * * *",
      configured_at: new Date("2026-10-01T00:00:00.000Z"),
      last_success_at: new Date("2026-10-15T03:00:00.000Z"),
    })
    expect(new Date((deadline ?? 0) * 1_000).toISOString()).toBe(
      "2026-10-15T03:01:01.000Z"
    )
  })

  test("uses the next weekday deadline across a weekend", () => {
    const row = {
      schedule_cron: "0 3 * * 1-5",
      configured_at: new Date("2026-10-01T03:00:00.000Z"),
      last_success_at: new Date("2026-10-16T03:00:00.000Z"),
    }

    expect(
      backupIsStale(row, new Date("2026-10-17T15:00:00.000Z"))
    ).toBe(false)
    expect(
      backupIsStale(row, new Date("2026-10-18T23:59:59.000Z"))
    ).toBe(false)
    expect(
      backupIsStale(row, new Date("2026-10-19T14:59:59.000Z"))
    ).toBe(false)
    expect(
      backupIsStale(row, new Date("2026-10-19T15:00:00.000Z"))
    ).toBe(false)
    expect(
      backupIsStale(row, new Date("2026-10-19T15:00:01.000Z"))
    ).toBe(true)
  })

  test("keeps the first scheduled occurrence strict around the reference", () => {
    const justBefore = {
      schedule_cron: "0 * * * *",
      configured_at: new Date("2026-10-01T00:00:00.000Z"),
      last_success_at: new Date("2026-10-15T03:59:59.999Z"),
    }
    expect(
      backupIsStale(justBefore, new Date("2026-10-15T04:30:00.000Z"))
    ).toBe(false)
    expect(
      backupIsStale(justBefore, new Date("2026-10-15T04:30:01.000Z"))
    ).toBe(true)

    const exactlyOnOccurrence = {
      ...justBefore,
      last_success_at: new Date("2026-10-15T04:00:00.000Z"),
    }
    expect(
      backupIsStale(
        exactlyOnOccurrence,
        new Date("2026-10-15T05:30:00.000Z")
      )
    ).toBe(false)
    expect(
      backupIsStale(
        exactlyOnOccurrence,
        new Date("2026-10-15T05:30:01.000Z")
      )
    ).toBe(true)
  })
})
