// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"

mock.module("../env", () => ({
  env: {
    PLOYDOK_PUBLIC_SCHEME: "http",
    PLOYDOK_PUBLIC_HOST: "localhost",
    PLOYDOK_PUBLIC_PORT: 8181,
  },
}))

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

describe("publishHealthyAppRoute over HTTP", () => {
  it("keeps TLS not required when DNS is missing on an HTTP deployment", async () => {
    const { publishHealthyAppRoute } = await import("./routing")
    const updates: Array<Record<string, unknown>> = []
    let routeApplied = false

    const result = await publishHealthyAppRoute({
      db: makeDb(updates),
      appId: "app-1",
      hostname: "app.example.com",
      inspectDns: async () => ({
        status: "missing",
        records: [],
        expectedRecords: [
          { type: "A", name: "app.example.com", value: "127.0.0.1" },
        ],
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      inspectTls: async () => ({
        status: "not_required",
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      applyRoute: async () => {
        routeApplied = true
      },
    })

    expect(routeApplied).toBe(false)
    expect(result).toMatchObject({
      status: "action_required",
      routeApplied: false,
      dnsStatus: "missing",
      tlsStatus: "not_required",
    })
    expect(updates.at(-1)).toMatchObject({
      routing_status: "action_required",
      routing_dns_status: "missing",
      routing_tls_status: "not_required",
    })
  })
})
