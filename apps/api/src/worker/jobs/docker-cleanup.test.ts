// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { delayUntil2350Utc, isDockerCleanupScheduleEnabled } from "./docker-cleanup"

describe("Docker cleanup schedule", () => {
  it("targets Dokploy's 23:50 UTC daily schedule", () => {
    expect(delayUntil2350Utc(new Date("2026-08-23T23:49:00.000Z"))).toBe(60_000)
    expect(delayUntil2350Utc(new Date("2026-08-23T23:50:00.000Z"))).toBe(
      24 * 60 * 60 * 1000
    )
  })

  it("is explicitly disabled unless the operator enables it", () => {
    expect(isDockerCleanupScheduleEnabled(false)).toBe(false)
    expect(isDockerCleanupScheduleEnabled(true)).toBe(true)
  })
})
