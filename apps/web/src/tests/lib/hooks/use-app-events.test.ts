// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tests for use-app-events.ts — pure helpers only (no React hooks).
 * Pattern: extract the pure logic functions and test them in isolation.
 */
import { describe, expect, it } from "bun:test"
import {
  SUBSCRIBED_TYPES,
  SUPPORTED_TYPES,
  buildAppEvent,
  eventBelongsToApp,
  mergeHistory,
  prependEvent,
} from "../../../lib/hooks/use-app-events"
import type { AppEvent, AppEventType } from "../../../lib/hooks/use-app-events"

// ---------------------------------------------------------------------------
// eventBelongsToApp
// ---------------------------------------------------------------------------

describe("eventBelongsToApp", () => {
  it("returns true when appId matches", () => {
    expect(
      eventBelongsToApp("build.started", { appId: "app-1" }, "app-1"),
    ).toBe(true)
  })

  it("returns false when appId does not match", () => {
    expect(
      eventBelongsToApp("build.started", { appId: "app-2" }, "app-1"),
    ).toBe(false)
  })

  it("returns false when appId is absent from payload", () => {
    expect(eventBelongsToApp("build.started", {}, "app-1")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildAppEvent
// ---------------------------------------------------------------------------

describe("buildAppEvent", () => {
  it("uses payload.id when present", () => {
    const event = buildAppEvent("build.started", {
      id: "evt-abc",
      appId: "app-1",
      t: 1000,
    })
    expect(event.id).toBe("evt-abc")
  })

  it("falls back to generated id when payload has no id", () => {
    const event = buildAppEvent("build.started", {
      appId: "app-1",
      buildId: "build-99",
      t: 2000,
    })
    expect(event.id).toContain("build.started")
    expect(event.id).toContain("build-99")
  })

  it("uses payload.t as timestamp", () => {
    const event = buildAppEvent("deploy.status_change", {
      appId: "app-1",
      t: 12345,
    })
    expect(event.timestamp).toBe(12345)
  })

  it("falls back to Date.now() when t is absent", () => {
    const before = Date.now()
    const event = buildAppEvent("build.failed", { appId: "app-1" })
    const after = Date.now()
    expect(event.timestamp).toBeGreaterThanOrEqual(before)
    expect(event.timestamp).toBeLessThanOrEqual(after)
  })

  it("sets the correct type", () => {
    const event = buildAppEvent("container.health", { appId: "app-1", t: 1 })
    expect(event.type).toBe("container.health")
  })
})

// ---------------------------------------------------------------------------
// prependEvent
// ---------------------------------------------------------------------------

describe("prependEvent", () => {
  const makeEvent = (id: string): AppEvent => ({
    id,
    type: "build.started",
    timestamp: Date.now(),
    data: {},
  })

  it("prepends the new event at index 0", () => {
    const list = [makeEvent("b")]
    const result = prependEvent(list, makeEvent("a"), 10)
    expect(result[0].id).toBe("a")
    expect(result[1].id).toBe("b")
  })

  it("deduplicates events with the same id", () => {
    const list = [makeEvent("a"), makeEvent("b")]
    const result = prependEvent(list, makeEvent("a"), 10)
    expect(result.length).toBe(2)
  })

  it("caps list to the specified limit", () => {
    let list: Array<AppEvent> = []
    for (let i = 0; i < 12; i++) {
      list = prependEvent(list, makeEvent(`evt-${i}`), 10)
    }
    expect(list.length).toBe(10)
    // Most recent is last prepended
    expect(list[0].id).toBe("evt-11")
  })

  it("respects limit=1", () => {
    const list = prependEvent([], makeEvent("first"), 1)
    const result = prependEvent(list, makeEvent("second"), 1)
    expect(result.length).toBe(1)
    expect(result[0].id).toBe("second")
  })
})

// ---------------------------------------------------------------------------
// SUPPORTED_TYPES
// ---------------------------------------------------------------------------

describe("SUPPORTED_TYPES", () => {
  it("includes all 5 expected event types", () => {
    const expected: Array<AppEventType> = [
      "build.started",
      "build.succeeded",
      "build.failed",
      "deploy.status_change",
      "container.health",
    ]
    expect(SUPPORTED_TYPES).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// SUBSCRIBED_TYPES — what the activity feed actually listens to live.
// container.health is excluded on purpose (telemetry, not activity).
// ---------------------------------------------------------------------------

describe("SUBSCRIBED_TYPES", () => {
  it("excludes container.health (continuous telemetry, not activity)", () => {
    expect(SUBSCRIBED_TYPES).not.toContain("container.health")
  })

  it("includes the four build/deploy event types", () => {
    expect(SUBSCRIBED_TYPES).toContain("build.started")
    expect(SUBSCRIBED_TYPES).toContain("build.succeeded")
    expect(SUBSCRIBED_TYPES).toContain("build.failed")
    expect(SUBSCRIBED_TYPES).toContain("deploy.status_change")
  })
})

// ---------------------------------------------------------------------------
// mergeHistory — seeds the live event list with fetched historical events.
// ---------------------------------------------------------------------------

describe("mergeHistory", () => {
  const mk = (id: string, ts: number): AppEvent => ({
    id,
    type: "build.started",
    timestamp: ts,
    data: {},
  })

  it("prepends history entries that aren't already in the list", () => {
    const current = [mk("live-1", 200)]
    const history = [mk("hist-1", 100), mk("hist-2", 50)]
    const result = mergeHistory(current, history, 10)
    expect(result.map((e) => e.id)).toEqual(["live-1", "hist-1", "hist-2"])
  })

  it("dedupes by id (live wins)", () => {
    const current = [mk("shared", 200)]
    const history = [mk("shared", 100), mk("hist-only", 50)]
    const result = mergeHistory(current, history, 10)
    expect(result.length).toBe(2)
    expect(result.find((e) => e.id === "shared")?.timestamp).toBe(200)
  })

  it("sorts newest-first regardless of input order", () => {
    const current = [mk("b", 200)]
    const history = [mk("a", 300), mk("c", 100)]
    const result = mergeHistory(current, history, 10)
    expect(result.map((e) => e.id)).toEqual(["a", "b", "c"])
  })

  it("caps the result to limit", () => {
    const current = [mk("a", 500)]
    const history = Array.from({ length: 20 }, (_, i) =>
      mk(`h-${i}`, 100 - i),
    )
    const result = mergeHistory(current, history, 5)
    expect(result.length).toBe(5)
    expect(result[0].id).toBe("a")
  })
})
