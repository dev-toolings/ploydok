// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "bun:test"
import { HostStatsResponse } from "@ploydok/agent-proto"
import { EventBus, type NotificationEvent } from "../worker/event-bus"
import { HostStatsLive } from "./host-stats-live"
import { buildHostStatsBody } from "./host-stats-body"

function fixture(
  fetch = async () => HostStatsResponse.create({ cpuCount: 4 })
) {
  let now = 1000
  let starts = 0
  let stops = 0
  let warnings = 0
  let scheduled: (() => void) | undefined
  const bus = new EventBus()
  const live = new HostStatsLive({
    fetch,
    bus,
    now: () => now,
    schedule: (tick, interval) => {
      expect(interval).toBe(2000)
      starts++
      scheduled = tick
      return () => {
        stops++
        scheduled = undefined
      }
    },
    warn: () => {
      warnings++
    },
  })
  return {
    live,
    bus,
    setNow: (value: number) => {
      now = value
    },
    counts: () => ({ starts, stops, warnings }),
    scheduled: () => scheduled,
  }
}

test("leases renew by user and client, share one timer, and stop after release or expiry", async () => {
  const f = fixture()
  expect(f.scheduled()).toBeUndefined()
  f.live.renew("u1", "client-01")
  f.live.renew("u1", "client-02")
  f.live.renew("u2", "client-01")
  expect(f.counts().starts).toBe(1)
  f.live.release("u1", "client-01")
  f.live.release("u1", "client-02")
  expect(f.counts().stops).toBe(0)
  f.setNow(40_000)
  f.live.renew("u2", "client-01")
  f.setNow(46_000)
  await f.live.tick()
  expect(f.counts().stops).toBe(0)
  f.setNow(85_000)
  await f.live.tick()
  expect(f.counts().stops).toBe(1)
  expect(f.scheduled()).toBeUndefined()
  f.live.renew("u1", "client-01")
  expect(f.counts().starts).toBe(2)
  f.live.release("u1", "client-01")
  expect(f.counts().stops).toBe(2)
})

test("one fetch fans out once per leased user with the shared body and no replay", async () => {
  let calls = 0
  const response = HostStatsResponse.create({
    cpuCount: 2,
    load1: 4,
    diskTotalBytes: 100,
    diskUsedBytes: 90,
  })
  const f = fixture(async () => {
    calls++
    return response
  })
  const events: NotificationEvent[] = []
  const unsubs = ["u1", "u2"].map((id) =>
    f.bus.subscribe(`user:${id}`, (e) => {
      events.push(e)
    })
  )
  await f.live.tick()
  expect(calls).toBe(0)
  f.live.renew("u1", "client-01")
  f.live.renew("u1", "client-02")
  f.live.renew("u2", "client-01")
  await f.live.tick()
  expect(calls).toBe(1)
  expect(events).toHaveLength(2)
  for (const event of events) {
    expect(event).toMatchObject({
      type: "host.stats",
      message: "",
      t: 1000,
      data: buildHostStatsBody(response, 1000),
    })
    expect(event.id).toBeTruthy()
  }
  expect(f.bus.replay("user:u1")).toEqual([])
  expect(f.live.freshSnapshot()).toEqual(buildHostStatsBody(response, 1000))
  f.setNow(3999)
  expect(f.live.freshSnapshot()).toBeDefined()
  f.setNow(4000)
  expect(f.live.freshSnapshot()).toBeUndefined()
  f.setNow(46_000)
  await f.live.tick()
  unsubs.forEach((unsub) => unsub())
})

test("failed agent ticks recover and warnings are limited to once per 30 seconds", async () => {
  let fails = true
  const f = fixture(async () => {
    if (fails) throw new Error("unavailable")
    return HostStatsResponse.create()
  })
  f.live.renew("u1", "client-01")
  await f.live.tick()
  await f.live.tick()
  expect(f.counts().warnings).toBe(1)
  expect(f.live.freshSnapshot()).toBeUndefined()
  f.setNow(31_000)
  await f.live.tick()
  expect(f.counts().warnings).toBe(2)
  fails = false
  await f.live.tick()
  expect(f.live.freshSnapshot()).toBeDefined()
  f.live.release("u1", "client-01")
})

test("overlapping ticks share the in-flight collection and released leases get no event", async () => {
  let resolve!: (response: HostStatsResponse) => void
  let calls = 0
  const f = fixture(() => {
    calls++
    return new Promise<HostStatsResponse>((done) => {
      resolve = done
    })
  })
  const received: NotificationEvent[] = []
  const unsub = f.bus.subscribe("user:u1", (e) => {
    received.push(e)
  })
  f.live.renew("u1", "client-01")
  const pending = f.live.tick()
  await f.live.tick()
  expect(calls).toBe(1)
  f.live.release("u1", "client-01")
  resolve(HostStatsResponse.create())
  await pending
  expect(received).toEqual([])
  expect(f.live.freshSnapshot()).toBeUndefined()
  expect(f.scheduled()).toBeUndefined()
  unsub()
})

test("reclaimed memory requires a gap above both 256 MiB and five percent", () => {
  const MiB = 1024 * 1024
  for (const [configured, gap, expected] of [
    [0, 0, 0],
    [4096 * MiB, 256 * MiB, 0],
    [4096 * MiB, 256 * MiB + 1, 256 * MiB + 1],
    [10240 * MiB, 512 * MiB, 0],
    [10240 * MiB, 512 * MiB + 1, 512 * MiB + 1],
    [6144 * MiB, 3276 * MiB, 3276 * MiB],
    [4096 * MiB, -MiB, 0],
  ] as const) {
    const usable = configured === 0 ? 4096 * MiB : configured - gap
    const body = buildHostStatsBody(
      HostStatsResponse.create({
        memConfiguredBytes: configured,
        memTotalBytes: usable,
        memAvailableBytes: usable * 0.05,
      }),
      1000
    )
    expect(body.mem_configured_bytes).toBe(configured)
    expect(body.mem_reclaimed_bytes).toBe(expected)
    expect(body.alerts).toContain("mem_high:95.0%")
  }
})
