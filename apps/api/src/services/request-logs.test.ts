// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, spyOn } from "bun:test"
import {
  mapRequestHosts,
  parseCaddyRequest,
  requestApp,
  RequestLogs,
  runtimeLogSource,
} from "./request-logs"
import { REQUEST_LOG_NAME } from "../caddy/access-logging"
import type { RequestLog } from "./request-logs"
import type { Agent } from "../agent"

function access(overrides = {}) {
  return JSON.stringify({
    logger: REQUEST_LOG_NAME,
    ts: Date.now() / 1000,
    request: {
      method: "GET",
      host: "MENU.Example.com:8181",
      uri: "/menu?token=secret",
      remote_ip: "192.0.2.1",
      headers: { Authorization: ["secret"], Cookie: ["secret"] },
    },
    status: 200,
    duration: 0.012,
    size: 42,
    request_id: "req-123",
    ...overrides,
  })
}

describe("Caddy request parser", () => {
  it("emits only safe fields and strips query values, headers and addresses", () => {
    const entry = parseCaddyRequest(access())!
    expect(entry).toMatchObject({
      kind: "request",
      method: "GET",
      host: "menu.example.com",
      path: "/menu",
      status: 200,
      durationMs: 12,
      size: 42,
      requestId: "req-123",
    })
    expect(Object.keys(entry).sort()).toEqual(
      [
        "t",
        "kind",
        "method",
        "host",
        "path",
        "status",
        "durationMs",
        "size",
        "requestId",
        "line",
      ].sort()
    )
    expect(JSON.stringify(entry)).not.toContain("secret")
    expect(entry.line).toContain("GET /menu  200  12 ms")
  })
  it("rejects non-access and malformed lines and derives levels from status", () => {
    for (const line of [
      "broken",
      "null",
      access({ logger: "http.log.error" }),
      access({ status: "200" }),
      access({ duration: -1 }),
    ])
      expect(parseCaddyRequest(line)).toBeNull()
    expect(parseCaddyRequest(access({ status: 404 }))?.line).toStartWith(
      "[warn]"
    )
    expect(parseCaddyRequest(access({ status: 503 }))?.line).toStartWith(
      "[error]"
    )
  })
})

it("maps primary and extra hosts, normalizes ports and case, and fails closed on conflicts", () => {
  const hosts = mapRequestHosts([
    { appId: "a", host: "menu.example.com" },
    { appId: "a", host: "alias.example.com" },
    { appId: "b", host: "other.example.com" },
    { appId: "b", host: "ALIAS.example.com" },
    { appId: "w", host: "*.wild.example.com" },
  ])
  expect(requestApp(hosts, "MENU.example.com:8181")).toBe("a")
  expect(requestApp(hosts, "other.example.com")).toBe("b")
  expect(requestApp(hosts, "alias.example.com")).toBeUndefined()
  expect(requestApp(hosts, "ploydok.example.com")).toBeUndefined()
  expect(requestApp(hosts, "a.wild.example.com")).toBe("w")
  expect(requestApp(hosts, "a.b.wild.example.com")).toBeUndefined()
})

it("validates the runtime source", () => {
  expect(runtimeLogSource()).toBe("app")
  for (const source of ["app", "requests", "all"] as const)
    expect(runtimeLogSource(source)).toBe(source)
  expect(runtimeLogSource("headers")).toBeNull()
})

it("shares a single follow reader, routes and replays per app, and cancels at last unsubscribe", async () => {
  let now = Date.now()
  using _clock = spyOn(Date, "now").mockImplementation(() => now)
  let rows = [{ appId: "a", host: "menu.example.com" }]
  let reads = 0
  let stops = 0
  let deliver: ((value: IteratorResult<{ line: string }>) => void) | undefined
  const iterator = {
    next: () =>
      new Promise<IteratorResult<{ line: string }>>((resolve) => {
        deliver = resolve
      }),
    return: async () => {
      stops++
      deliver?.({ done: true, value: undefined })
      return { done: true as const, value: undefined }
    },
  }
  const bus = new RequestLogs({
    agent: () =>
      ({
        listContainers: async () => ({
          containers: [
            {
              id: "caddy-task",
              name: "ploydok_caddy.1.task",
              status: "running",
            },
          ],
        }),
        containerLogs: (options: { containerId: string; follow: boolean }) => {
          reads++
          expect(options.containerId).toBe("caddy-task")
          expect(options.follow).toBe(true)
          return { [Symbol.asyncIterator]: () => iterator }
        },
      }) as unknown as Pick<Agent, "listContainers" | "containerLogs">,
    loadHosts: async () => rows,
  })
  const first: RequestLog[] = [],
    second: RequestLog[] = [],
    foreign: RequestLog[] = []
  const off1 = bus.subscribe("a", (entry) => first.push(entry))
  const off2 = bus.subscribe("a", (entry) => second.push(entry))
  const off3 = bus.subscribe("b", (entry) => foreign.push(entry))
  await Bun.sleep(5)
  deliver!({ done: false, value: { line: access() } })
  await Bun.sleep(5)
  expect(reads).toBe(1)
  expect(first).toHaveLength(1)
  expect(second).toHaveLength(1)
  expect(foreign).toHaveLength(0)
  expect(await bus.replay("a")).toEqual(first)
  expect(await bus.replay("b")).toEqual([])
  rows = [{ appId: "b", host: "menu.example.com" }]
  now += 10_001
  expect(await bus.replay("a")).toEqual([])
  deliver!({ done: false, value: { line: access() } })
  await Bun.sleep(5)
  expect(foreign).toHaveLength(1)
  expect(first).toHaveLength(1)
  off1()
  off2()
  expect(stops).toBe(0)
  off3()
  await Bun.sleep(5)
  expect(stops).toBeGreaterThan(0)
})
