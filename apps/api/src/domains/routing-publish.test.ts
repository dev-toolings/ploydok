// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "node:events"
import { apps, builds } from "@ploydok/db"

type DnsMode = "missing" | "valid"
type TlsMode = "issued" | "failed"

let dnsMode: DnsMode = "missing"
let tlsMode: TlsMode = "issued"
let tlsConnectCalls = 0

Bun.env["PLOYDOK_PUBLIC_SCHEME"] = "https"
Bun.env["PLOYDOK_PUBLIC_HOST"] = "localhost"

const dnsNotFound = () => {
  const error = new Error("record not found") as NodeJS.ErrnoException
  error.code = "ENOTFOUND"
  return Promise.reject<string[]>(error)
}

mock.module("node:dns/promises", () => ({
  resolve4: async (hostname: string) => {
    if (dnsMode === "missing") return dnsNotFound()
    if (hostname === "app.example.com" || hostname === "localhost") {
      return ["127.0.0.1"]
    }
    return dnsNotFound()
  },
  resolve6: dnsNotFound,
  resolveCname: dnsNotFound,
  resolveTxt: dnsNotFound,
}))

const fakeTls = {
  connect: () => {
    tlsConnectCalls++
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void
    }
    socket.destroy = () => {}
    queueMicrotask(() => {
      if (tlsMode === "issued") {
        socket.emit("secureConnect")
      } else {
        socket.emit("error", new Error("ACME certificate unavailable"))
      }
    })
    return socket
  },
}
mock.module("node:tls", () => ({ ...fakeTls, default: fakeTls }))

function makeDb(updates: Array<Record<string, unknown>>) {
  return {
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values)
          return { where: async () => [] }
        },
      }
    },
  } as never
}

function makeDbWithAppSnapshot(
  updates: Array<Record<string, unknown>>,
  snapshot: Record<string, unknown>
) {
  return {
    select(selection?: Record<string, unknown>) {
      const selected = Object.keys(selection ?? {})
      return {
        from(table: unknown) {
          const rows = table === apps && selected.includes("routing_status")
            ? [snapshot]
            : []
          return {
            where() {
              return { limit: async () => rows }
            },
          }
        },
      }
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values)
          return { where: async () => [] }
        },
      }
    },
  } as never
}

function makeDbWithRoutingSnapshots(opts: {
  appSnapshot: Record<string, unknown>
  buildSnapshots?: Array<Record<string, unknown>>
  appUpdates: Array<Record<string, unknown>>
  buildUpdates: Array<Record<string, unknown>>
}) {
  return {
    select(selection?: Record<string, unknown>) {
      const selected = Object.keys(selection ?? {})
      return {
        from(table: unknown) {
          const rows = table === apps && selected.includes("routing_status")
            ? [opts.appSnapshot]
            : table === builds && selected.includes("routing_domain")
              ? (opts.buildSnapshots ?? [])
              : []
          return {
            where() {
              return {
                limit: async () => rows,
                orderBy() {
                  return { limit: async () => rows }
                },
              }
            },
          }
        },
      }
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          if (table === builds) opts.buildUpdates.push(values)
          else opts.appUpdates.push(values)
          return { where: async () => [] }
        },
      }
    },
  } as never
}

describe("publishHealthyAppRoute", () => {
  it("keeps a healthy deployment separate from missing DNS, then becomes ready when DNS and TLS recover", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    const updates: Array<Record<string, unknown>> = []
    let routeCalls = 0
    const db = makeDb(updates)

    dnsMode = "missing"
    tlsMode = "issued"
    const missing = await publishHealthyAppRoute({
      db,
      appId: "app-1",
      hostname: "app.example.com",
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(missing).toMatchObject({
      status: "action_required",
      routeApplied: false,
      dnsStatus: "missing",
      tlsStatus: "pending",
    })
    expect(routeCalls).toBe(0)
    expect(updates.at(-1)).toMatchObject({
      routing_status: "action_required",
      routing_dns_status: "missing",
      routing_tls_status: "pending",
    })

    dnsMode = "valid"
    const ready = await publishHealthyAppRoute({
      db,
      appId: "app-1",
      hostname: "app.example.com",
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(ready).toMatchObject({
      status: "ready",
      dnsStatus: "valid",
      tlsStatus: "issued",
    })
    expect(ready).toMatchObject({ routeApplied: true })
    expect(routeCalls).toBe(1)
    expect(updates.at(-1)).toMatchObject({
      routing_status: "ready",
      routing_dns_status: "valid",
      routing_tls_status: "issued",
    })
  })

  it("fails the deployment when the primary route cannot be applied", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    dnsMode = "valid"
    await expect(
      publishHealthyAppRoute({
        db: makeDb([]),
        appId: "app-1",
        hostname: "app.example.com",
        inspectTls: async () => ({
          status: "issued",
          checkedAt: new Date().toISOString(),
          error: null,
        }),
        applyRoute: async () => {
          throw new Error("Caddy unavailable")
        },
      })
    ).rejects.toThrow("Caddy unavailable")
  })

  it("requires valid DNS before applying a custom route", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    let routeCalls = 0
    const result = await publishHealthyAppRoute({
      db: makeDb([]),
      appId: "app-1",
      hostname: "custom.example.com",
      inspectDns: async () => ({
        status: "valid",
        records: [{ type: "A", value: "203.0.113.10" }],
        expectedRecords: [],
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      inspectTls: async () => ({
        status: "not_required",
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(result).toMatchObject({
      status: "ready",
      routeApplied: true,
      dnsStatus: "valid",
    })
    expect(routeCalls).toBe(1)
  })

  it("bypasses the DNS gate for an instance-managed localhost route", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    let routeCalls = 0
    const result = await publishHealthyAppRoute({
      db: makeDb([]),
      appId: "app-1",
      hostname: "app.localhost",
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(result).toMatchObject({
      status: "ready",
      routeApplied: true,
      dnsStatus: "unknown",
      tlsStatus: "issued",
    })
    expect(routeCalls).toBe(1)
  })

  it("does not open a TLS connection during a preview inspection", async () => {
    const { inspectDomainTls } = await import("./routing")
    tlsConnectCalls = 0
    const result = await inspectDomainTls("custom.example.com")

    expect(result).toMatchObject({ status: "pending", error: null })
    expect(tlsConnectCalls).toBe(0)
  })

  it("keeps the runtime deployment successful when ACME still needs attention", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    const updates: Array<Record<string, unknown>> = []
    let routeCalls = 0
    dnsMode = "valid"
    tlsMode = "failed"

    const result = await publishHealthyAppRoute({
      db: makeDb(updates),
      appId: "app-1",
      hostname: "app.example.com",
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(result).toMatchObject({
      status: "action_required",
      dnsStatus: "valid",
      tlsStatus: "failed",
    })
    expect(result.error).toContain("ACME certificate unavailable")
    expect(routeCalls).toBe(1)
    expect(updates.at(-1)).toMatchObject({
      routing_status: "action_required",
      routing_dns_status: "valid",
      routing_tls_status: "failed",
    })
  })

  it("switches an already served proxied custom host without a fresh TXT lookup", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    const updates: Array<Record<string, unknown>> = []
    let routeCalls = 0

    const result = await publishHealthyAppRoute({
      db: makeDbWithAppSnapshot(updates, {
        id: "app-1",
        domain: "proxied.example.com",
        domain_source: "custom",
        routing_status: "ready",
        routing_dns_status: "unknown",
        routing_tls_status: "issued",
      }),
      appId: "app-1",
      hostname: "proxied.example.com",
      proxied: true,
      inspectDns: async () => ({
        status: "unknown",
        records: [{ type: "A", value: "104.16.1.1" }],
        expectedRecords: [],
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      inspectTls: async () => ({
        status: "not_required",
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(result).toMatchObject({
      status: "ready",
      routeApplied: true,
      dnsStatus: "unknown",
    })
    expect(routeCalls).toBe(1)
  })

  it("does not apply a new proxied host without an ownership proof", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    let routeCalls = 0

    const result = await publishHealthyAppRoute({
      db: makeDb([]),
      appId: "app-new",
      hostname: "new-proxied.example.com",
      proxied: true,
      inspectDns: async () => ({
        status: "unknown",
        records: [{ type: "A", value: "104.16.1.1" }],
        expectedRecords: [],
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      inspectTls: async () => ({
        status: "not_required",
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      verifyOwnership: async () => false,
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(result).toMatchObject({
      status: "action_required",
      routeApplied: false,
      dnsStatus: "unknown",
    })
    expect(result.error).toContain("DOMAIN_OWNERSHIP_REQUIRED")
    expect(routeCalls).toBe(0)
  })

  it("uses a successful same-app build hostname as durable route proof", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    const appUpdates: Array<Record<string, unknown>> = []
    const buildUpdates: Array<Record<string, unknown>> = []
    let routeCalls = 0

    const result = await publishHealthyAppRoute({
      db: makeDbWithRoutingSnapshots({
        appSnapshot: {
          id: "app-1",
          domain: "current.example.com",
          domain_source: "custom",
          routing_status: "action_required",
          routing_dns_status: "unknown",
          routing_tls_status: "issued",
        },
        buildSnapshots: [{ routing_domain: "served.example.com" }],
        appUpdates,
        buildUpdates,
      }),
      appId: "app-1",
      hostname: "served.example.com",
      proxied: true,
      inspectDns: async () => ({
        status: "unknown",
        records: [{ type: "A", value: "104.16.1.1" }],
        expectedRecords: [],
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      inspectTls: async () => ({
        status: "not_required",
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      verifyOwnership: async () => false,
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(result).toMatchObject({
      status: "ready",
      routeApplied: true,
      dnsStatus: "unknown",
    })
    expect(routeCalls).toBe(1)
    expect(buildUpdates).toEqual([])
  })

  it("does not write routing_domain when a successful build is blocked before publication", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    const appUpdates: Array<Record<string, unknown>> = []
    const buildUpdates: Array<Record<string, unknown>> = []
    let routeCalls = 0

    const result = await publishHealthyAppRoute({
      db: makeDbWithRoutingSnapshots({
        appSnapshot: {
          id: "app-1",
          domain: "old.example.com",
          domain_source: "custom",
          routing_status: "action_required",
          routing_dns_status: "unknown",
          routing_tls_status: "issued",
        },
        appUpdates,
        buildUpdates,
      }),
      appId: "app-1",
      buildId: "build-blocked",
      hostname: "blocked.example.com",
      proxied: true,
      inspectDns: async () => ({
        status: "unknown",
        records: [{ type: "A", value: "104.16.1.1" }],
        expectedRecords: [],
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      inspectTls: async () => ({
        status: "not_required",
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      verifyOwnership: async () => false,
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(result).toMatchObject({
      status: "action_required",
      routeApplied: false,
      dnsStatus: "unknown",
    })
    expect(routeCalls).toBe(0)
    expect(buildUpdates).toEqual([])
  })

  it("does not use a different live Caddy host as proof for a new hostname", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    let routeCalls = 0

    const result = await publishHealthyAppRoute({
      db: makeDbWithRoutingSnapshots({
        appSnapshot: {
          id: "app-1",
          domain: "new.example.com",
          domain_source: "custom",
          routing_status: "action_required",
          routing_dns_status: "unknown",
          routing_tls_status: "issued",
        },
        appUpdates: [],
        buildUpdates: [],
      }),
      appId: "app-1",
      hostname: "new.example.com",
      proxied: true,
      inspectDns: async () => ({
        status: "unknown",
        records: [{ type: "A", value: "104.16.1.1" }],
        expectedRecords: [],
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      inspectTls: async () => ({
        status: "not_required",
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      verifyOwnership: async () => false,
      getCurrentRouteHost: async () => "other.example.com",
      applyRoute: async () => {
        routeCalls++
      },
    })

    expect(result).toMatchObject({
      status: "action_required",
      routeApplied: false,
      dnsStatus: "unknown",
    })
    expect(result.error).toContain("DOMAIN_OWNERSHIP_REQUIRED")
    expect(routeCalls).toBe(0)
  })
})
