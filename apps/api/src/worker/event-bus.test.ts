// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "bun:test"
import { EventBus } from "./event-bus"

// Helper to build a minimal valid event payload (without id/t — bus auto-fills them).
function makeEvent(overrides: Partial<Parameters<EventBus["publish"]>[1]> = {}): Parameters<EventBus["publish"]>[1] {
  return {
    type: "build.started",
    message: "Build queued",
    ...overrides,
  }
}

describe("EventBus — ring-buffer", () => {
  test("stores events and replay returns them chronologically", () => {
    const bus = new EventBus()
    bus.publish("user:u1", makeEvent({ message: "first" }))
    bus.publish("user:u1", makeEvent({ message: "second" }))
    bus.publish("user:u1", makeEvent({ message: "third" }))

    const events = bus.replay("user:u1")
    expect(events).toHaveLength(3)
    expect(events[0]!.message).toBe("first")
    expect(events[1]!.message).toBe("second")
    expect(events[2]!.message).toBe("third")
  })

  test("ring-buffer caps at 50 events and overwrites oldest", () => {
    const bus = new EventBus()
    for (let i = 0; i < 55; i++) {
      bus.publish("user:u1", makeEvent({ message: `msg-${i}` }))
    }

    const events = bus.replay("user:u1", 50)
    expect(events).toHaveLength(50)
    // Oldest preserved should be msg-5 (0–4 were overwritten).
    expect(events[0]!.message).toBe("msg-5")
    // Most recent should be msg-54.
    expect(events[49]!.message).toBe("msg-54")
  })

  test("replay with limit returns only the N most recent in order", () => {
    const bus = new EventBus()
    for (let i = 0; i < 10; i++) {
      bus.publish("user:u1", makeEvent({ message: `msg-${i}` }))
    }

    const events = bus.replay("user:u1", 3)
    expect(events).toHaveLength(3)
    expect(events[0]!.message).toBe("msg-7")
    expect(events[1]!.message).toBe("msg-8")
    expect(events[2]!.message).toBe("msg-9")
  })

  test("replay returns empty array for unknown channel", () => {
    const bus = new EventBus()
    expect(bus.replay("user:nobody")).toEqual([])
  })
})

describe("EventBus — subscribe / unsubscribe", () => {
  test("subscriber receives published events", () => {
    const bus = new EventBus()
    const received: string[] = []

    bus.subscribe("user:u1", (e) => received.push(e.message))
    bus.publish("user:u1", makeEvent({ message: "hello" }))
    bus.publish("user:u1", makeEvent({ message: "world" }))

    expect(received).toEqual(["hello", "world"])
  })

  test("unsubscribe stops receiving events", () => {
    const bus = new EventBus()
    const received: string[] = []

    const unsub = bus.subscribe("user:u1", (e) => received.push(e.message))
    bus.publish("user:u1", makeEvent({ message: "before" }))
    unsub()
    bus.publish("user:u1", makeEvent({ message: "after" }))

    expect(received).toEqual(["before"])
  })

  test("multiple subscribers on same channel all receive events", () => {
    const bus = new EventBus()
    const a: string[] = []
    const b: string[] = []

    bus.subscribe("user:u1", (e) => a.push(e.message))
    bus.subscribe("user:u1", (e) => b.push(e.message))
    bus.publish("user:u1", makeEvent({ message: "ping" }))

    expect(a).toEqual(["ping"])
    expect(b).toEqual(["ping"])
  })
})

describe("EventBus — error isolation", () => {
  test("a throwing subscriber does not crash other subscribers", () => {
    const bus = new EventBus()
    const received: string[] = []

    bus.subscribe("user:u1", () => {
      throw new Error("boom")
    })
    bus.subscribe("user:u1", (e) => received.push(e.message))

    expect(() => bus.publish("user:u1", makeEvent({ message: "safe" }))).not.toThrow()
    expect(received).toEqual(["safe"])
  })
})

describe("EventBus — evict", () => {
  test("evict clears ring-buffer but keeps subscribers active", () => {
    const bus = new EventBus()
    const received: string[] = []

    bus.subscribe("user:u1", (e) => received.push(e.message))
    bus.publish("user:u1", makeEvent({ message: "stored" }))

    bus.evict("user:u1")

    // Ring-buffer is gone — replay returns empty.
    expect(bus.replay("user:u1")).toEqual([])

    // Subscriber is still active — new publishes reach it.
    bus.publish("user:u1", makeEvent({ message: "after-evict" }))
    expect(received).toEqual(["stored", "after-evict"])
  })
})

describe("EventBus — channel isolation", () => {
  test("events on one channel do not bleed into another", () => {
    const bus = new EventBus()
    const u1Events: string[] = []
    const monEvents: string[] = []

    bus.subscribe("user:u1", (e) => u1Events.push(e.message))
    bus.subscribe("monitoring:u1", (e) => monEvents.push(e.message))

    bus.publish("user:u1", makeEvent({ message: "user event" }))
    bus.publish("monitoring:u1", makeEvent({ type: "container.health", message: "healthy" }))

    expect(u1Events).toEqual(["user event"])
    expect(monEvents).toEqual(["healthy"])
    expect(bus.replay("user:u1")).toHaveLength(1)
    expect(bus.replay("monitoring:u1")).toHaveLength(1)
  })
})

describe("EventBus — auto-generated fields", () => {
  test("publish auto-generates id and t when absent", () => {
    const bus = new EventBus()
    bus.publish("user:u1", makeEvent())

    const [event] = bus.replay("user:u1", 1)
    expect(typeof event!.id).toBe("string")
    expect(event!.id.length).toBeGreaterThan(0)
    expect(typeof event!.t).toBe("number")
    expect(event!.t).toBeGreaterThan(0)
  })

  test("publish preserves explicit id and t when provided", () => {
    const bus = new EventBus()
    bus.publish("user:u1", makeEvent({ id: "fixed-id", t: 1000 }))

    const [event] = bus.replay("user:u1", 1)
    expect(event!.id).toBe("fixed-id")
    expect(event!.t).toBe(1000)
  })
})

test("ephemeral events reach subscribers but never displace notification replay", () => {
  const bus = new EventBus()
  const received: string[] = []
  bus.subscribe("user:u1", () => { throw new Error("subscriber failure") })
  bus.subscribe("user:u1", (event) => { received.push(event.id) })
  bus.publish("user:u1", makeEvent({ id: "saved" }))
  for (let i = 0; i < 60; i++) {
    bus.publishEphemeral("user:u1", { type: "host.stats", message: "", id: `live-${i}`, t: 1000, data: { cpu_count: 4 } })
  }
  expect(received).toHaveLength(61)
  expect(bus.replay("user:u1").map((e) => e.id)).toEqual(["saved"])
  bus.publishEphemeral("user:u2", { type: "host.stats", message: "" })
  expect(bus.replay("user:u2")).toEqual([])
})
