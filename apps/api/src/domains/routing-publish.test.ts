// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "node:events"

type DnsMode = "missing" | "valid"
type TlsMode = "issued" | "failed"

let dnsMode: DnsMode = "missing"
let tlsMode: TlsMode = "issued"

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
}))

const fakeTls = {
  connect: () => {
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
      dnsStatus: "missing",
      tlsStatus: "pending",
    })
    expect(routeCalls).toBe(1)
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
    expect(routeCalls).toBe(2)
    expect(updates.at(-1)).toMatchObject({
      routing_status: "ready",
      routing_dns_status: "valid",
      routing_tls_status: "issued",
    })
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
})
