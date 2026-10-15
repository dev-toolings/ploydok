// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {
  expectedDnsRecords,
  inspectDomainDns,
  inspectDomainTls,
} from "./routing"

const notFound = () => {
  const error = new Error("not found") as NodeJS.ErrnoException
  error.code = "ENOTFOUND"
  return Promise.reject<string[]>(error)
}

describe("expectedDnsRecords", () => {
  it("expects a CNAME for a hostname-based public endpoint", () => {
    expect(expectedDnsRecords("app.example.com", "proxy.example.net")).toEqual([
      { type: "CNAME", name: "app.example.com", value: "proxy.example.net" },
    ])
  })

  it("expects an address record for an IP public endpoint", () => {
    expect(expectedDnsRecords("app.example.com", "203.0.113.10")).toEqual([
      { type: "A", name: "app.example.com", value: "203.0.113.10" },
    ])
  })
})

describe("inspectDomainDns", () => {
  it("reports missing DNS without claiming that the hostname is ready", async () => {
    const result = await inspectDomainDns("app.example.com", {
      publicHost: "203.0.113.10",
      functions: {
        resolve4: notFound,
        resolve6: notFound,
        resolveCname: notFound,
      },
    })

    expect(result.status).toBe("missing")
    expect(result.records).toEqual([])
    expect(result.expectedRecords).toEqual([
      { type: "A", name: "app.example.com", value: "203.0.113.10" },
    ])
  })

  it("reports valid DNS only when the observed record reaches the public endpoint", async () => {
    const result = await inspectDomainDns("APP.Example.com", {
      publicHost: "203.0.113.10",
      functions: {
        resolve4: async (hostname) =>
          hostname === "app.example.com" ? ["203.0.113.10"] : [],
        resolve6: notFound,
        resolveCname: notFound,
      },
    })

    expect(result.status).toBe("valid")
    expect(result.records).toEqual([
      { type: "A", value: "203.0.113.10" },
    ])
    expect(result.error).toBeNull()
  })

  it("reports a mismatch when DNS resolves somewhere else", async () => {
    const result = await inspectDomainDns("app.example.com", {
      publicHost: "203.0.113.10",
      functions: {
        resolve4: async () => ["198.51.100.20"],
        resolve6: notFound,
        resolveCname: notFound,
      },
    })

    expect(result.status).toBe("mismatch")
    expect(result.error).toContain("do not point")
  })

  it("does not claim readiness when one of several address records is wrong", async () => {
    const result = await inspectDomainDns("app.example.com", {
      publicHost: "203.0.113.10",
      functions: {
        resolve4: async () => ["203.0.113.10", "198.51.100.20"],
        resolve6: notFound,
        resolveCname: notFound,
      },
    })

    expect(result.records).toEqual([
      { type: "A", value: "203.0.113.10" },
      { type: "A", value: "198.51.100.20" },
    ])
    expect(result.status).toBe("mismatch")
    expect(result.error).toContain("do not point")
  })

  it("does not accept a dangling CNAME without a resolvable target", async () => {
    const result = await inspectDomainDns("app.example.com", {
      publicHost: "proxy.example.net",
      functions: {
        resolve4: async (hostname) => {
          if (hostname === "app.example.com") return notFound()
          return notFound()
        },
        resolve6: notFound,
        resolveCname: async (hostname) =>
          hostname === "app.example.com"
            ? ["proxy.example.net"]
            : notFound(),
      },
    })

    expect(result.records).toEqual([
      { type: "CNAME", value: "proxy.example.net" },
    ])
    expect(result.status).toBe("mismatch")
    expect(result.error).toContain("do not point")
  })

  it("skips DNS lookups for generated localhost domains", async () => {
    let lookups = 0
    const lookup = async () => {
      lookups++
      throw new Error("generated domains must not query DNS")
    }

    const result = await inspectDomainDns("app.demo.localhost", {
      publicHost: "localhost",
      functions: {
        resolve4: lookup,
        resolve6: lookup,
        resolveCname: lookup,
      },
    })

    expect(result).toMatchObject({
      status: "unknown",
      records: [],
      expectedRecords: [],
      error: null,
    })
    expect(lookups).toBe(0)
  })

  it("skips generated-base DNS lookups while preserving setup instructions", async () => {
    let lookups = 0
    const lookup = async () => {
      lookups++
      throw new Error("generated domains must not query DNS")
    }

    const result = await inspectDomainDns("app.apps.example.com", {
      publicHost: "control.example.com",
      domainBase: "apps.example.com",
      functions: {
        resolve4: lookup,
        resolve6: lookup,
        resolveCname: lookup,
      },
    })

    expect(result).toMatchObject({
      status: "unknown",
      records: [],
      expectedRecords: [
        {
          type: "CNAME",
          name: "app.apps.example.com",
          value: "control.example.com",
        },
      ],
      error: null,
    })
    expect(lookups).toBe(0)
  })

  it("reports proxied DNS as unknown instead of claiming it points to the host", async () => {
    const result = await inspectDomainDns("app.example.com", {
      publicHost: "203.0.113.10",
      proxied: true,
      functions: {
        resolve4: async () => ["104.16.1.1"],
        resolve6: notFound,
        resolveCname: notFound,
      },
    })

    expect(result.status).toBe("unknown")
  })
})

describe("inspectDomainTls", () => {
  it("keeps TLS out of the DNS action when the public scheme is HTTP", async () => {
    const result = await inspectDomainTls("app.example.com", { scheme: "http" })
    expect(result).toMatchObject({ status: "not_required", error: null })
  })

  it("does not provision or probe TLS until a route is authorized", async () => {
    const result = await inspectDomainTls("app.example.com", { scheme: "https" })
    expect(result).toMatchObject({ status: "pending", error: null })
  })
})
