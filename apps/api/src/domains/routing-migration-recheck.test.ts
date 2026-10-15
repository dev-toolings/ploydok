// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { apps, builds } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { ROUTING_MIGRATION_ERROR } from "./app-domain"
import {
  recheckMigrationRoutingDrift,
  type DnsInspection,
  type TlsInspection,
} from "./routing"

const checkedAt = "2026-10-15T00:00:00.000Z"

function dns(
  status: DnsInspection["status"],
  error: string | null = null
): DnsInspection {
  return {
    status,
    records: [],
    expectedRecords: [],
    checkedAt,
    error,
  }
}

function tls(
  status: TlsInspection["status"],
  error: string | null = null
): TlsInspection {
  return { status, checkedAt, error }
}

function sentinel(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    domain: "app.example.com",
    status: "running",
    routing_status: "action_required",
    routing_error: ROUTING_MIGRATION_ERROR,
    cdn_mode: "off",
    ...overrides,
  }
}

function makeDb(
  appRows: Array<Record<string, unknown>>,
  buildsRows: Array<Record<string, unknown>> = []
) {
  const updates: Array<Record<string, unknown>> = []
  const db = {
    select(selection?: Record<string, unknown>) {
      const keys = Object.keys(selection ?? {})
      return {
        from(table: unknown) {
          return {
            where() {
              const rows =
                table === builds
                  ? buildsRows
                  : table === apps && keys.includes("routing_error")
                    ? appRows
                    : []
              const ordered = Object.assign(Promise.resolve(rows), {
                limit: async () => rows,
              })
              return {
                orderBy: () => ordered,
                limit: async () => rows,
              }
            },
          }
        },
      }
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values)
          return {
            where() {
              return { returning: async () => [{ id: "ok" }] }
            },
          }
        },
      }
    },
  }
  return { db: db as unknown as Db, updates }
}

const throwingDns = {
  resolve4: async () => {
    throw new Error("generated domains must not query DNS")
  },
  resolve6: async () => {
    throw new Error("generated domains must not query DNS")
  },
  resolveCname: async () => {
    throw new Error("generated domains must not query DNS")
  },
}

describe("recheckMigrationRoutingDrift", () => {
  it("marks instance-managed domains ready without a DNS lookup", async () => {
    const { db, updates } = makeDb([
      sentinel({
        id: "local",
        domain: "artipizz-92bp9mgc.demo.localhost",
      }),
      sentinel({
        id: "sslip",
        domain: "shop.203-0-113-10.sslip.io",
      }),
    ])

    const outcome = await recheckMigrationRoutingDrift(db, {
      publicHost: "203.0.113.10",
      domainBase: "203-0-113-10.sslip.io",
      scheme: "http",
      dnsFunctions: throwingDns,
    })

    expect(outcome).toEqual({
      managedReady: 2,
      customReady: 0,
      customActionRequired: 0,
      deferred: 0,
    })
    expect(updates).toEqual([
      {
        routing_status: "ready",
        routing_error: null,
        routing_dns_status: "unknown",
        routing_tls_status: "not_required",
      },
      {
        routing_status: "ready",
        routing_error: null,
        routing_dns_status: "unknown",
        routing_tls_status: "not_required",
      },
    ])
  })

  it("stores a definitive custom DNS failure and leaves transport errors for the next boot", async () => {
    const missing = makeDb([sentinel()])
    const missingOutcome = await recheckMigrationRoutingDrift(missing.db, {
      publicHost: "203.0.113.10",
      domainBase: "apps.example.com",
      scheme: "http",
      inspectDns: async () => dns("missing"),
      inspectTls: async () => {
        throw new Error("TLS must not be probed when DNS is not acceptable")
      },
    })
    expect(missingOutcome.customActionRequired).toBe(1)
    expect(missing.updates).toEqual([
      {
        routing_status: "action_required",
        routing_error: "DOMAIN_DNS_REQUIRED",
        routing_dns_status: "missing",
        routing_tls_status: "not_required",
      },
    ])

    const deferred = makeDb([sentinel()])
    const deferredOutcome = await recheckMigrationRoutingDrift(deferred.db, {
      publicHost: "203.0.113.10",
      domainBase: "apps.example.com",
      scheme: "https",
      inspectDns: async () => dns("error", "DNS lookup timed out"),
      inspectTls: async () => {
        throw new Error("TLS must not be probed after a DNS transport error")
      },
    })
    expect(deferredOutcome).toEqual({
      managedReady: 0,
      customReady: 0,
      customActionRequired: 0,
      deferred: 1,
    })
    expect(deferred.updates).toEqual([])
  })

  it("marks a custom domain ready only after DNS and TLS both pass", async () => {
    let tlsCalls = 0
    const { db, updates } = makeDb([sentinel()])
    const outcome = await recheckMigrationRoutingDrift(db, {
      publicHost: "203.0.113.10",
      domainBase: "apps.example.com",
      scheme: "https",
      inspectDns: async () => dns("valid"),
      inspectTls: async () => {
        tlsCalls++
        return tls("issued")
      },
    })

    expect(tlsCalls).toBe(1)
    expect(outcome.customReady).toBe(1)
    expect(updates).toEqual([
      {
        routing_status: "ready",
        routing_error: null,
        routing_dns_status: "valid",
        routing_tls_status: "issued",
      },
    ])
  })

  it("keeps the banner when a custom TLS probe fails", async () => {
    const { db, updates } = makeDb([sentinel({ domain: "app.example.com" })])
    const outcome = await recheckMigrationRoutingDrift(db, {
      publicHost: "203.0.113.10",
      domainBase: "apps.example.com",
      scheme: "https",
      inspectDns: async () => dns("valid"),
      inspectTls: async () => tls("failed", "TLS handshake timed out"),
    })

    expect(outcome.customActionRequired).toBe(1)
    expect(updates[0]).toMatchObject({
      routing_status: "action_required",
      routing_dns_status: "valid",
      routing_tls_status: "failed",
    })
    expect(updates[0]?.routing_error).toContain("TLS handshake timed out")
  })

  it("accepts unknown DNS for a custom domain already recorded on a successful build", async () => {
    const { db, updates } = makeDb(
      [sentinel({ cdn_mode: "off" })],
      [{ routing_domain: "app.example.com" }]
    )
    const outcome = await recheckMigrationRoutingDrift(db, {
      publicHost: "proxy.example.net",
      domainBase: "apps.example.com",
      scheme: "http",
      inspectDns: async () => dns("unknown"),
    })

    expect(outcome.customReady).toBe(1)
    expect(updates[0]).toMatchObject({
      routing_status: "ready",
      routing_dns_status: "unknown",
      routing_tls_status: "not_required",
      routing_error: null,
    })
  })

  it("ignores rows that are not waiting on the migration sentinel", async () => {
    const { db, updates } = makeDb([
      sentinel({
        id: "checked",
        routing_error: "DOMAIN_DNS_REQUIRED",
        domain: "checked.example.com",
      }),
    ])
    const outcome = await recheckMigrationRoutingDrift(db, {
      publicHost: "203.0.113.10",
      domainBase: "apps.example.com",
      scheme: "http",
      inspectDns: async () => {
        throw new Error("rows outside the sentinel must not be inspected")
      },
    })

    expect(outcome).toEqual({
      managedReady: 0,
      customReady: 0,
      customActionRequired: 0,
      deferred: 0,
    })
    expect(updates).toEqual([])
  })

  it("finishes instance-managed rows before a slow custom lookup", async () => {
    const { db, updates } = makeDb([
      sentinel({ id: "custom", domain: "custom.example.com" }),
      sentinel({ id: "local", domain: "artipizz.demo.localhost" }),
    ])
    let releaseCustom: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      releaseCustom = resolve
    })
    let customStarted: () => void = () => {}
    const customSawManaged = new Promise<void>((resolve) => {
      customStarted = resolve
    })

    const pending = recheckMigrationRoutingDrift(db, {
      publicHost: "localhost",
      domainBase: "demo.localhost",
      scheme: "http",
      inspectDns: async (hostname) => {
        if (hostname.endsWith(".localhost")) return dns("unknown")
        customStarted()
        await hold
        return dns("valid")
      },
    })

    await customSawManaged
    expect(updates).toEqual([
      {
        routing_status: "ready",
        routing_error: null,
        routing_dns_status: "unknown",
        routing_tls_status: "not_required",
      },
    ])
    releaseCustom()
    const outcome = await pending
    expect(outcome).toEqual({
      managedReady: 1,
      customReady: 1,
      customActionRequired: 0,
      deferred: 0,
    })
    expect(updates).toHaveLength(2)
  })
})
