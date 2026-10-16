// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, mock } from "bun:test"
import { Hono } from "hono"
import { HostStatsResponse } from "@ploydok/agent-proto"
import type { Db } from "@ploydok/db"
import type { AuthUser } from "../auth/middleware"
import { HostStatsLive } from "../observability/host-stats-live"
import { EventBus } from "../worker/event-bus"

let agentCalls = 0
mock.module("../debug/singletons", () => ({
  getSharedAgent: () => ({
    hostStats: async (_request: unknown, timeout: number) => {
      expect(timeout).toBe(5000)
      agentCalls++
      return HostStatsResponse.create({ cpuCount: 8 })
    },
  }),
}))
const { createHostStatsRouter } = await import("./host-stats")

function fixture(owner = true, authenticated = true) {
  let now = 1000
  let starts = 0
  let stops = 0
  let checks = 0
  const live = new HostStatsLive({
    fetch: async () => HostStatsResponse.create({ cpuCount: 4 }),
    bus: new EventBus(),
    now: () => now,
    schedule: () => {
      starts++
      return () => {
        stops++
      }
    },
    warn: () => {},
  })
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            checks++
            return owner ? [{ id: "membership-1" }] : []
          },
        }),
      }),
    }),
  } as unknown as Db
  const app = new Hono<{ Variables: { user?: AuthUser } }>()
  app.use("*", async (c, next) => {
    if (authenticated)
      c.set("user", {
        id: "u1",
        email: "owner@example.test",
        display_name: "Owner",
        session_id: "s1",
      })
    await next()
  })
  app.route("/host-stats", createHostStatsRouter(db, live))
  const watch = (method: string, body: unknown = { clientId: "client-01" }) =>
    app.request("/host-stats/watch", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return {
    app,
    live,
    watch,
    setNow: (value: number) => {
      now = value
    },
    counts: () => ({ starts, stops, checks }),
  }
}

test("watch and GET require authentication and owner membership", async () => {
  for (const [owner, authenticated, expected] of [
    [true, false, 401],
    [false, true, 403],
  ] as const) {
    const f = fixture(owner, authenticated)
    for (const method of ["POST", "DELETE"]) {
      const response = await f.watch(method)
      expect(response.status).toBe(expected)
      if (expected === 403)
        expect(await response.json()).toEqual({ error: "admin_required" })
    }
    expect((await f.app.request("/host-stats")).status).toBe(expected)
    expect(f.counts().starts).toBe(0)
    if (!authenticated) expect(f.counts().checks).toBe(0)
  }
})

test("owner watch validates both methods and renews/releases the lease", async () => {
  const f = fixture()
  for (const method of ["POST", "DELETE"]) {
    for (const body of [
      {},
      { clientId: "short" },
      { clientId: "x".repeat(65) },
      { clientId: 123 },
    ]) {
      expect((await f.watch(method, body)).status).toBe(400)
    }
    expect(
      (await f.app.request("/host-stats/watch", { method, body: "{" })).status
    ).toBe(400)
  }
  expect(f.counts().starts).toBe(0)
  const response = await f.watch("POST")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ intervalMs: 2000, leaseMs: 45000 })
  expect((await f.watch("POST")).status).toBe(200)
  expect(f.counts().starts).toBe(1)
  const released = await f.watch("DELETE")
  expect(released.status).toBe(204)
  expect(await released.text()).toBe("")
  expect(f.counts().stops).toBe(1)
})

test("GET serves a fresh collector body and falls back to the agent after 3 seconds", async () => {
  agentCalls = 0
  const f = fixture()
  expect(
    (
      (await (await f.app.request("/host-stats")).json()) as {
        cpu_count: number
      }
    ).cpu_count
  ).toBe(8)
  expect(agentCalls).toBe(1)
  await f.watch("POST")
  await f.live.tick()
  expect(await (await f.app.request("/host-stats")).json()).toEqual(
    f.live.freshSnapshot()
  )
  expect(agentCalls).toBe(1)
  f.setNow(4000)
  expect(
    (
      (await (await f.app.request("/host-stats")).json()) as {
        cpu_count: number
      }
    ).cpu_count
  ).toBe(8)
  expect(agentCalls).toBe(2)
  await f.watch("DELETE")
})
