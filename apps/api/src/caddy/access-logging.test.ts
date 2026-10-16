// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from "bun:test"
import { CaddyClient } from "./client"
import {
  requestLogOutput,
  requestServerLogs,
  withRequestId,
  REQUEST_LOGGER,
} from "./access-logging"
import type { CaddyConfig } from "./types"

it("selects only app hosts and keeps credentials redacted", () => {
  const logs = requestServerLogs({}, ["app.example.com"])
  expect(logs).toEqual({
    logger_names: { "app.example.com": [REQUEST_LOGGER] },
    skip_unmapped_hosts: true,
    should_log_credentials: false,
  })
  expect(logs.logger_names["ploydok.example.com"]).toBeUndefined()
  expect(requestLogOutput).toMatchObject({
    writer: { output: "stdout" },
    encoder: { format: "json" },
  })
})
it("preserves a supplied request id and uses the same request header for upstream and log", () => {
  const route = withRequestId({
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "app:8080" }] }],
  })
  expect(route.handle?.[0]).toMatchObject({
    handler: "subroute",
    routes: [
      {
        match: [{ header: { "X-Request-Id": null } }],
        handle: [
          {
            handler: "headers",
            request: { set: { "X-Request-Id": ["{http.request.uuid}"] } },
          },
        ],
      },
    ],
  })
  expect(route.handle?.[1]).toEqual({
    handler: "log_append",
    key: "request_id",
    value: "{http.request.header.X-Request-Id}",
  })
  expect(withRequestId(route)).toEqual(route)
})
it("reinstalls logging on all HTTP servers after a base-config restart, preserving control-plane routes", async () => {
  const originalFetch = globalThis.fetch
  const config: CaddyConfig = {
    apps: {
      http: {
        servers: {
          srv0: {
            routes: [
              {
                "@id": "ploydok-a",
                match: [{ host: ["app.example.com"] }],
                handle: [],
              },
              {
                "@id": "control-plane",
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: "web:3000" }],
                  },
                ],
              },
            ],
          },
          srv1: { routes: [] },
        },
      },
    },
  }
  const writes: Array<{ path: string; body: unknown }> = []
  globalThis.fetch = (async (input, options) => {
    const path = new URL(String(input)).pathname
    if (!options?.method) return Response.json(config)
    writes.push({ path, body: JSON.parse(String(options.body)) })
    return new Response(null, { status: 200 })
  }) as typeof fetch
  try {
    await new CaddyClient("http://caddy.invalid").ensureRequestLogging([
      "app.example.com",
    ])
    expect(
      writes.find((w) => w.path === "/config/logging")?.body
    ).toMatchObject({ logs: { [REQUEST_LOGGER]: requestLogOutput } })
    for (const server of ["srv0", "srv1"])
      expect(
        writes.some(
          (w) => w.path === `/config/apps/http/servers/${server}/logs`
        )
      ).toBe(true)
    const routes = writes.find((w) => w.path.endsWith("srv0/routes"))
      ?.body as unknown[]
    expect(routes[1]).toEqual(config.apps!.http!.servers!.srv0!.routes![1])
    expect(routes[0]).toMatchObject({
      handle: [{ handler: "subroute" }, { handler: "log_append" }],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

it("serializes app-route writes so concurrent apps retain both logger mappings", async () => {
  const originalFetch = globalThis.fetch
  const config: CaddyConfig = {
    apps: { http: { servers: { srv0: { routes: [] } } } },
  }
  globalThis.fetch = (async (input, options) => {
    const path = new URL(String(input)).pathname
    const server = config.apps!.http!.servers!.srv0!
    if (!options?.method)
      return Response.json(path.endsWith("/routes") ? server.routes : config)
    const body = JSON.parse(String(options.body))
    if (path === "/config/logging") config.logging = body
    if (path.endsWith("/logs")) server.logs = body
    if (path.endsWith("/routes")) server.routes = body
    return new Response(null, { status: 200 })
  }) as typeof fetch
  try {
    const client = new CaddyClient("http://caddy.invalid")
    await Promise.all([
      client.upsertRoute({
        appId: "a",
        host: "a.example.com",
        upstream: "a:8080",
      }),
      client.upsertRoute({
        appId: "b",
        host: "b.example.com",
        upstream: "b:8080",
      }),
    ])
    const server = config.apps!.http!.servers!.srv0!
    expect(server.routes).toHaveLength(2)
    expect(Object.keys(server.logs!.logger_names!)).toEqual([
      "a.example.com",
      "b.example.com",
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
