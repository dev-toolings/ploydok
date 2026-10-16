// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CaddyClient } from "./client.js"
import type { CaddyConfig } from "./types.js"

// ---------------------------------------------------------------------------
// Minimal HTTP server harness using Bun.serve
// ---------------------------------------------------------------------------

interface MockRequest {
  method: string
  path: string
  body: unknown
}

interface MockResponse {
  status: number
  body: unknown
}

type Handler = (req: MockRequest) => MockResponse

let server: ReturnType<typeof Bun.serve> | null = null
let handler: Handler = () => ({ status: 200, body: null })

function startServer(): string {
  server = Bun.serve({
    port: 0, // random free port
    fetch(req) {
      const url = new URL(req.url)
      return req.text().then((text) => {
        let body: unknown = null
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          body = text
        }
        const result = req.method === "PUT" && (url.pathname === "/config/logging" || url.pathname.endsWith("/logs"))
          ? { status: 200, body: null }
          : handler({ method: req.method, path: url.pathname, body })
        return new Response(
          result.body !== null ? JSON.stringify(result.body) : "",
          {
            status: result.status,
            headers: { "Content-Type": "application/json" },
          }
        )
      })
    },
  })
  return `http://127.0.0.1:${server.port}`
}

function stopServer(): void {
  server?.stop(true)
  server = null
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CaddyClient", () => {
  let baseUrl: string
  let client: CaddyClient

  beforeEach(() => {
    baseUrl = startServer()
    client = new CaddyClient(baseUrl)
  })

  afterEach(() => {
    stopServer()
  })

  // -------------------------------------------------------------------------
  // getConfig
  // -------------------------------------------------------------------------

  test("getConfig returns parsed config", async () => {
    const mockConfig: CaddyConfig = { apps: { http: { servers: {} } } }
    handler = () => ({ status: 200, body: mockConfig })

    const config = await client.getConfig()
    expect(config).toEqual(mockConfig)
  })

  test("getConfig returns empty object when Caddy returns null", async () => {
    handler = () => ({ status: 200, body: null })

    const config = await client.getConfig()
    expect(config).toEqual({})
  })

  test("getConfig throws on non-2xx", async () => {
    handler = () => ({ status: 500, body: { error: "oops" } })

    await expect(client.getConfig()).rejects.toThrow(
      "CaddyClient.getConfig failed: 500"
    )
  })

  test("uses CADDY_ADMIN_URL as the default base URL", async () => {
    const previous = process.env["CADDY_ADMIN_URL"]
    process.env["CADDY_ADMIN_URL"] = baseUrl
    handler = () => ({ status: 200, body: { apps: { http: { servers: {} } } } })

    try {
      const defaultClient = new CaddyClient()
      const config = await defaultClient.getConfig()
      expect(config).toEqual({ apps: { http: { servers: {} } } })
    } finally {
      if (previous === undefined) {
        delete process.env["CADDY_ADMIN_URL"]
      } else {
        process.env["CADDY_ADMIN_URL"] = previous
      }
    }
  })

  // -------------------------------------------------------------------------
  // upsertRoute — app routes are prepended before the control-plane fallback
  // -------------------------------------------------------------------------

  test("upsertRoute prepends a new route before existing routes", async () => {
    const calls: MockRequest[] = []
    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
    }

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET" && req.path === "/config/")
        return { status: 200, body: existingConfig }
      if (
        req.method === "GET" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return {
          status: 200,
          body: [{ "@id": "control-plane", terminal: true }],
        }
      if (
        req.method === "PATCH" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.upsertRoute({
      host: "app1.localhost",
      upstream: "localhost:3001",
      appId: "app1",
    })

    const put = calls.find((c) => c.method === "PATCH")
    expect(put?.path).toBe("/config/apps/http/servers/srv0/routes")

    const routes = put?.body as Array<Record<string, unknown>>
    expect(routes[0]?.["@id"]).toBe("ploydok-app1")
    expect(routes[0]?.["terminal"]).toBe(true)
    expect(routes[1]?.["@id"]).toBe("control-plane")
  })

  test("upsertRoute replaces an existing route and keeps it first", async () => {
    const calls: MockRequest[] = []
    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
    }

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET" && req.path === "/config/")
        return { status: 200, body: existingConfig }
      if (
        req.method === "GET" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return {
          status: 200,
          body: [
            { "@id": "control-plane", terminal: true },
            { "@id": "ploydok-app2", terminal: true },
          ],
        }
      if (
        req.method === "PATCH" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.upsertRoute({
      host: "app2.localhost",
      upstream: "localhost:3002",
      appId: "app2",
    })

    const put = calls.find((c) => c.method === "PATCH")
    const routes = put?.body as Array<Record<string, unknown>>
    expect(routes.map((route) => route["@id"])).toEqual([
      "ploydok-app2",
      "control-plane",
    ])
  })

  test("upsertStaticRoute writes a file_server route with SPA fallback", async () => {
    const calls: MockRequest[] = []
    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
    }

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET" && req.path === "/config/")
        return { status: 200, body: existingConfig }
      if (
        req.method === "GET" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: [] }
      if (
        req.method === "PATCH" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.upsertStaticRoute({
      host: "static.localhost",
      root: "/var/lib/ploydok/static/app1/current",
      appId: "app1",
      spaFallback: true,
    })

    const put = calls.find((c) => c.method === "PATCH")
    const routes = put?.body as Array<{
      handle?: Array<{ handler?: string; routes?: unknown[] }>
    }>
    const posted = routes[0]!
    expect(posted.handle?.[2]?.handler).toBe("subroute")
    expect(posted.handle?.[2]?.routes).toHaveLength(2)
  })

  test("upsertStaticRoute can disable SPA fallback and expose a direct file_server", async () => {
    const calls: MockRequest[] = []
    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
    }

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET" && req.path === "/config/")
        return { status: 200, body: existingConfig }
      if (
        req.method === "GET" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: [] }
      if (
        req.method === "PATCH" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.upsertStaticRoute({
      host: "static.localhost",
      root: "/var/lib/ploydok/static/app1/current",
      appId: "app1",
      spaFallback: false,
    })

    const put = calls.find((c) => c.method === "PATCH")
    const routes = put?.body as Array<{
      handle?: Array<{ handler?: string; root?: string }>
    }>
    const posted = routes[0]!
    expect(posted.handle?.slice(2)).toEqual([
      {
        handler: "file_server",
        root: "/var/lib/ploydok/static/app1/current",
      },
    ])
  })

  test("upsertStaticRoute injects CDN handlers ahead of the static file_server", async () => {
    const calls: MockRequest[] = []
    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
    }

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET" && req.path === "/config/")
        return { status: 200, body: existingConfig }
      if (
        req.method === "GET" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: [] }
      if (
        req.method === "PATCH" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.upsertStaticRoute({
      host: "static.localhost",
      root: "/var/lib/ploydok/static/app1/current",
      appId: "app1",
      spaFallback: false,
      cdn: {
        cdn_mode: "internal",
        cdn_cache_ttl_s: 900,
        cdn_cache_paths: ["/assets/*"],
        cdn_compression: true,
        cdn_image_optim: true,
        cdn_headers: '{"Cache-Control":"public, max-age=900"}',
        cdn_external_provider: null,
      },
    })

    const put = calls.find((c) => c.method === "PATCH")
    const routes = put?.body as Array<{
      handle?: Array<{
        handler?: string
        routes?: Array<{
          handle?: Array<{ handler?: string }>
        }>
        response?: { set?: Record<string, string[]> }
      }>
    }>
    const posted = routes[0]!
    const handlers = posted.handle?.slice(2) ?? []

    expect(handlers.map((handler) => handler.handler)).toEqual([
      "subroute",
      "encode",
      "subroute",
      "headers",
      "file_server",
    ])
    expect(handlers[0]?.routes?.[0]?.handle?.[0]?.handler).toBe("image_filter")
    expect(handlers[1]).toMatchObject({
      handler: "encode",
      encodings: { br: {}, zstd: {}, gzip: {} },
    })
    expect(handlers[2]?.routes?.[0]?.handle?.[0]).toMatchObject({
      handler: "cache",
      ttl: "900s",
      default_cache_control: "public, max-age=900",
    })
    expect(handlers[3]?.response?.set).toEqual({
      "Cache-Control": ["public, max-age=900"],
    })
    expect(handlers[4]).toMatchObject({
      handler: "file_server",
      root: "/var/lib/ploydok/static/app1/current",
    })
  })

  test("upsertRoute throws when route list update fails", async () => {
    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
    }
    handler = (req) => {
      if (req.method === "GET" && req.path === "/config/")
        return { status: 200, body: existingConfig }
      if (
        req.method === "GET" &&
        req.path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: [] }
      return { status: 500, body: { error: "internal" } }
    }

    await expect(
      client.upsertRoute({
        host: "app3.localhost",
        upstream: "localhost:3003",
        appId: "app3",
      })
    ).rejects.toThrow("CaddyClient.upsertRoute PATCH routes failed: 500")
  })

  test("getRouteHost reads only the requested app route", async () => {
    const calls: MockRequest[] = []
    handler = (req) => {
      calls.push(req)
      if (req.method === "GET" && req.path === "/id/ploydok-app-1") {
        return {
          status: 200,
          body: {
            "@id": "ploydok-app-1",
            match: [{ host: ["app.example.com"] }],
            handle: [],
          },
        }
      }
      return { status: 404, body: null }
    }

    await expect(client.getRouteHost("app-1")).resolves.toBe("app.example.com")
    expect(calls).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/id/ploydok-app-1",
      }),
    ])
  })

  test("getRouteHost returns null when the app route is absent", async () => {
    const calls: MockRequest[] = []
    handler = (req) => {
      calls.push(req)
      return { status: 404, body: { error: "not found" } }
    }

    await expect(client.getRouteHost("missing-app")).resolves.toBeNull()
    expect(calls).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/id/ploydok-missing-app",
      }),
    ])
  })

  // -------------------------------------------------------------------------
  // removeRoute
  // -------------------------------------------------------------------------

  test("removeRoute sends DELETE to /id/ploydok-{appId}", async () => {
    const calls: MockRequest[] = []
    handler = (req) => {
      calls.push(req)
      return { status: 200, body: null }
    }

    await client.removeRoute("myapp")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("DELETE")
    expect(calls[0]?.path).toBe("/id/ploydok-myapp")
  })

  test("removeRoute is idempotent: 404 is treated as success", async () => {
    handler = () => ({ status: 404, body: { error: "not found" } })

    // Should not throw
    await expect(client.removeRoute("ghost")).resolves.toBeUndefined()
  })

  test("removeRoute throws on unexpected error", async () => {
    handler = () => ({ status: 500, body: { error: "boom" } })

    await expect(client.removeRoute("bad")).rejects.toThrow(
      "CaddyClient.removeRoute failed: 500"
    )
  })

  // -------------------------------------------------------------------------
  // ensureBootstrap
  // -------------------------------------------------------------------------

  test("ensureBootstrap PUT /config/apps when config is empty", async () => {
    const calls: MockRequest[] = []

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET") return { status: 200, body: null }
      if (req.method === "PUT") return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.ensureBootstrap()

    expect(calls).toHaveLength(2)
    expect(calls[0]?.method).toBe("GET")
    expect(calls[1]?.method).toBe("PUT")
    expect(calls[1]?.path).toBe("/config/apps")

    const posted = calls[1]?.body as Record<string, unknown>
    const http = posted["http"] as Record<string, unknown>
    const servers = http["servers"] as Record<string, unknown>
    expect(servers["srv0"]).toBeDefined()
  })

  test("ensureBootstrap PUT /config/apps/http/servers/srv0 when only srv0 missing", async () => {
    const calls: MockRequest[] = []
    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv1: { listen: [":443"], routes: [] } } } },
    }

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET") return { status: 200, body: existingConfig }
      if (req.method === "PUT") return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.ensureBootstrap()

    const put = calls.find((c) => c.method === "PUT")
    expect(put?.path).toBe("/config/apps/http/servers/srv0")
    const body = put?.body as Record<string, unknown>
    expect(body["listen"]).toEqual([":80"])
  })

  test("ensureBootstrap is a no-op when srv0 already exists", async () => {
    const calls: MockRequest[] = []

    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv0: { listen: [":443"], routes: [] } } } },
    }

    handler = (req) => {
      calls.push(req)
      return { status: 200, body: existingConfig }
    }

    await client.ensureBootstrap()

    // Only the GET, no POST
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("GET")
  })

  test("ensureBootstrap throws when PUT fails", async () => {
    let callCount = 0

    handler = (req) => {
      callCount++
      if (req.method === "GET") return { status: 200, body: null }
      return { status: 503, body: { error: "unavailable" } }
    }

    await expect(client.ensureBootstrap()).rejects.toThrow(
      "CaddyClient.ensureBootstrap failed creating apps: 503"
    )
    expect(callCount).toBe(2)
  })

  // -------------------------------------------------------------------------
  // DNS-01 TLS policy
  // -------------------------------------------------------------------------

  test("buildDns01TlsPolicy renders correct Caddy JSON shape", () => {
    const policy = client.buildDns01TlsPolicy("app.example.com", "cloudflare", {
      api_token: "tok123",
      zone_id: "zone-abc",
    })

    expect(policy).toEqual({
      subjects: ["app.example.com"],
      issuers: [
        {
          module: "acme",
          challenges: {
            dns: {
              provider: {
                name: "cloudflare",
                api_token: "tok123",
                zone_id: "zone-abc",
              },
            },
          },
        },
      ],
    })
  })

  // -------------------------------------------------------------------------
  // buildHandlers — middleware combination snapshots
  // -------------------------------------------------------------------------

  test("buildHandlers with no middlewares returns only reverse_proxy", () => {
    const handlers = client.buildHandlers("localhost:3001")
    expect(handlers).toHaveLength(1)
    expect(handlers[0]).toMatchObject({
      handler: "reverse_proxy",
      upstreams: [{ dial: "localhost:3001" }],
    })
  })

  test("buildHandlers with basicAuth prepends authentication handler", () => {
    const handlers = client.buildHandlers("localhost:3001", {
      basicAuth: { user: "admin", pass_hash: "$2b$10$abc" },
    })
    expect(handlers).toHaveLength(2)
    expect(handlers[0]).toMatchObject({ handler: "authentication" })
    expect(handlers[1]).toMatchObject({ handler: "reverse_proxy" })
  })

  test("buildHandlers with rateLimit prepends rate_limit handler first", () => {
    const handlers = client.buildHandlers("localhost:3001", {
      rateLimit: { rps: 50 },
    })
    expect(handlers).toHaveLength(2)
    expect(handlers[0]).toMatchObject({
      handler: "rate_limit",
      rate_limits: { default: { max_events: 50, window: "1s" } },
    })
    expect(handlers[1]).toMatchObject({ handler: "reverse_proxy" })
  })

  test("buildHandlers with ipAllowlist prepends subroute handler", () => {
    const handlers = client.buildHandlers("localhost:3001", {
      ipAllowlist: ["10.0.0.0/8"],
    })
    expect(handlers).toHaveLength(2)
    expect(handlers[0]).toMatchObject({ handler: "subroute" })
    expect(handlers[1]).toMatchObject({ handler: "reverse_proxy" })
  })

  test("buildHandlers combined: order is rate_limit → subroute → auth → proxy", () => {
    const handlers = client.buildHandlers("localhost:3001", {
      rateLimit: { rps: 10 },
      ipAllowlist: ["192.168.0.0/24"],
      basicAuth: { user: "u", pass_hash: "h" },
    })
    expect(handlers).toHaveLength(4)
    expect(handlers[0]).toMatchObject({ handler: "rate_limit" })
    expect(handlers[1]).toMatchObject({ handler: "subroute" })
    expect(handlers[2]).toMatchObject({ handler: "authentication" })
    expect(handlers[3]).toMatchObject({ handler: "reverse_proxy" })
  })

  test("buildHandlers with rateLimit=0 skips rate_limit handler", () => {
    const handlers = client.buildHandlers("localhost:3001", {
      rateLimit: { rps: 0 },
    })
    expect(handlers).toHaveLength(1)
    expect(handlers[0]).toMatchObject({ handler: "reverse_proxy" })
  })

  test("buildHandlers with extraHandlers inserts before reverse_proxy", () => {
    const extraHandlers = [
      { handler: "headers", response: { headers: { "X-Custom": ["test"] } } },
    ]
    const handlers = client.buildHandlers("localhost:3001", {
      extraHandlers,
    })
    expect(handlers).toHaveLength(2)
    expect(handlers[0]).toMatchObject({ handler: "headers" })
    expect(handlers[1]).toMatchObject({ handler: "reverse_proxy" })
  })

  test("buildHandlers combined with extraHandlers: order is rate_limit → subroute → auth → extra → proxy", () => {
    const extraHandlers = [{ handler: "vars", variables: { test: "value" } }]
    const handlers = client.buildHandlers("localhost:3001", {
      rateLimit: { rps: 10 },
      ipAllowlist: ["192.168.0.0/24"],
      basicAuth: { user: "u", pass_hash: "h" },
      extraHandlers,
    })
    expect(handlers).toHaveLength(5)
    expect(handlers[0]).toMatchObject({ handler: "rate_limit" })
    expect(handlers[1]).toMatchObject({ handler: "subroute" })
    expect(handlers[2]).toMatchObject({ handler: "authentication" })
    expect(handlers[3]).toMatchObject({ handler: "vars" })
    expect(handlers[4]).toMatchObject({ handler: "reverse_proxy" })
  })

  test("upsertDns01TlsPolicy PUTs updated policies list", async () => {
    const calls: MockRequest[] = []
    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
    }

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET") return { status: 200, body: existingConfig }
      if (req.method === "PUT") return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.upsertDns01TlsPolicy("app.example.com", "cloudflare", {
      api_token: "tok",
    })

    const put = calls.find((c) => c.method === "PUT")
    expect(put?.path).toBe("/config/apps/tls/automation/policies")
    const policies = put?.body as Array<Record<string, unknown>>
    expect(Array.isArray(policies)).toBe(true)
    expect(policies[0]?.["subjects"]).toEqual(["app.example.com"])
  })

  test("upsertTcpProxy PUTs a layer4 server with proxy upstream", async () => {
    const calls: MockRequest[] = []
    const existingConfig: CaddyConfig = {
      apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
    }

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET") return { status: 200, body: existingConfig }
      if (req.method === "PUT") return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.upsertTcpProxy({
      serverId: "db-proxy-1",
      listenPort: 16432,
      upstream: "db:5432",
    })

    const putPaths = calls.filter((c) => c.method === "PUT").map((c) => c.path)
    expect(putPaths).toContain("/config/apps/layer4")
    expect(putPaths).toContain("/config/apps/layer4/servers/db-proxy-1")
    const serverPut = calls.find(
      (c) => c.path === "/config/apps/layer4/servers/db-proxy-1"
    )
    expect(serverPut?.body).toMatchObject({
      listen: [":16432"],
      routes: [
        {
          "@id": "db-proxy-1",
          handle: [{ handler: "proxy", upstreams: [{ dial: ["db:5432"] }] }],
        },
      ],
    })
  })

  test("removeTcpProxy DELETEs the layer4 server path", async () => {
    const calls: MockRequest[] = []
    const existingConfig: CaddyConfig = {
      apps: {
        layer4: {
          servers: { "db-proxy-1": { listen: [":16432"], routes: [] } },
        },
      },
    }

    handler = (req) => {
      calls.push(req)
      if (req.method === "GET") return { status: 200, body: existingConfig }
      if (req.method === "DELETE") return { status: 200, body: null }
      return { status: 405, body: null }
    }

    await client.removeTcpProxy("db-proxy-1")

    const del = calls.find((c) => c.method === "DELETE")
    expect(del?.path).toBe("/config/apps/layer4/servers/db-proxy-1")
  })
})
