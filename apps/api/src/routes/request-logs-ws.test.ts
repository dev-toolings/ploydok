// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import * as database from "@ploydok/db"

let owner = false
let subscriptions = 0
let stopped = 0
let events: {
  onOpen: (event: unknown, ws: unknown) => Promise<void>
  onClose: () => void
}
const chain = {
  from: () => chain,
  innerJoin: () => chain,
  where: () => chain,
  limit: async () => (owner ? [{ id: "project-a" }] : []),
}
mock.module("@ploydok/db", () => ({
  ...database,
  createDb: () => ({ select: () => chain }),
}))
mock.module("../auth/jwt", () => ({
  ACCESS_COOKIE: "ploydok_access",
  verifyAccessToken: async () => ({ sub: "caller" }),
}))
mock.module("hono/bun", () => ({
  createBunWebSocket: () => ({
    websocket: {},
    upgradeWebSocket:
      (factory: (context: unknown) => typeof events) =>
      (context: { text: (text: string) => Response }) => {
        events = factory(context)
        return context.text("test adapter")
      },
  }),
}))
mock.module("../services/request-logs", () => ({
  runtimeLogSource: (value?: string) =>
    value === undefined || value === "app"
      ? "app"
      : ["requests", "all"].includes(value)
        ? value
        : null,
  getRequestLogs: () => ({
    replay: async () => [{ kind: "request", line: "GET / 200 1 ms" }],
    subscribe: () => {
      subscriptions++
      return () => {
        stopped++
      }
    },
  }),
}))
const { wsRouter } = await import("./ws")
afterAll(() => mock.restore())

it("authorizes request-only and combined streams before opening the shared reader", async () => {
  const app = new Hono().route("/ws", wsRouter)
  for (const source of ["requests", "all"]) {
    owner = false
    const codes: number[] = []
    await app.request(`/ws/apps/a/logs?source=${source}`, {
      headers: { cookie: "ploydok_access=test" },
    })
    await events.onOpen({}, { close: (code: number) => codes.push(code) })
    expect(codes).toEqual([4001])
    expect(subscriptions).toBe(0)
    events.onClose()
  }
  owner = true
  const sent: string[] = []
  await app.request("/ws/apps/a/logs?source=requests", {
    headers: { cookie: "ploydok_access=test" },
  })
  await events.onOpen(
    {},
    { send: (message: string) => sent.push(message), close: () => {} }
  )
  expect(subscriptions).toBe(1)
  expect(JSON.parse(sent[0]!)).toMatchObject({ kind: "request" })
  events.onClose()
  expect(stopped).toBe(1)
})
