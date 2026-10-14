// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { diskGrowth } from "./history"

const now = Date.parse("2026-10-13T12:00:00Z")
const sample = (daysAgo: number, usedBytes: number, totalBytes = 1_000) => ({
  measuredAt: new Date(now - daysAgo * 86_400_000).toISOString(),
  usedBytes,
  totalBytes,
})

describe("disk growth", () => {
  it("calculates seven-day growth and time until 90 percent", () => {
    expect(diskGrowth([sample(7, 200), sample(0, 270)], now)).toEqual({
      growth7dBytes: 70,
      daysTo90Percent: 63,
    })
  })
  it("does not invent a trend from a short or stale history", () => {
    expect(diskGrowth([sample(1, 200), sample(0, 270)], now)).toEqual({
      growth7dBytes: null,
      daysTo90Percent: null,
    })
    expect(diskGrowth([sample(7, 200), sample(1, 270)], now)).toEqual({
      growth7dBytes: null,
      daysTo90Percent: null,
    })
  })
  it("does not estimate saturation when disk use is decreasing", () => {
    expect(diskGrowth([sample(7, 270), sample(0, 200)], now)).toEqual({
      growth7dBytes: -70,
      daysTo90Percent: null,
    })
  })
  it("rejects a comparison after the filesystem capacity changes", () => {
    expect(diskGrowth([sample(7, 200), sample(0, 270, 2_000)], now)).toEqual({
      growth7dBytes: null,
      daysTo90Percent: null,
    })
  })
  it("reports zero days once the threshold is reached", () => {
    expect(diskGrowth([sample(7, 800), sample(0, 910)], now)).toEqual({
      growth7dBytes: 110,
      daysTo90Percent: 0,
    })
  })
})
