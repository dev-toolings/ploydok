// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { apps, domains, services } from "@ploydok/db"
import { env } from "../env"
import {
  DomainCollisionError,
  InvalidAppDomainError,
  assertDomainAvailable,
  findDomainCollisions,
  isDomainInCandidates,
  isUniqueDomainConstraintError,
} from "./availability"
import { domainCollisionCandidates, normalizeAppHostname } from "./app-domain"

type CollisionRows = {
  apps?: Array<{ id: string; hostname: string | null }>
  domains?: Array<{ id: string; appId?: string; hostname: string }>
  services?: Array<{ id: string; hostname: string | null }>
}

function makeDb(rows: CollisionRows = {}) {
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                limit: async () => {
                  if (table === apps) return rows.apps ?? []
                  if (table === domains) return rows.domains ?? []
                  if (table === services) return rows.services ?? []
                  return []
                },
              }
            },
          }
        },
      }
    },
  } as never
}

describe("application hostname normalization", () => {
  it("normalizes an origin-like hostname while rejecting paths and credentials", () => {
    expect(normalizeAppHostname(" HTTPS://App.Example.COM ")).toBe(
      "app.example.com"
    )
    expect(normalizeAppHostname("app.example.com/path")).toBeNull()
    expect(normalizeAppHostname("user:pass@app.example.com")).toBeNull()
    expect(normalizeAppHostname("app.example.com:8443")).toBeNull()
  })

  it("returns exact and wildcard candidates for a subdomain", () => {
    expect(domainCollisionCandidates("api.example.com")).toEqual([
      "api.example.com",
      "*.example.com",
    ])
    expect(isDomainInCandidates("api.example.com", "*.example.com")).toBe(
      true
    )
    expect(isDomainInCandidates("example.com", "*.example.com")).toBe(false)
  })
})

describe("domain availability", () => {
  it("reserves the instance hostname and wildcard coverage of it", async () => {
    const testEnv = env as { PLOYDOK_PUBLIC_HOST: string }
    const previousHost = testEnv.PLOYDOK_PUBLIC_HOST
    testEnv.PLOYDOK_PUBLIC_HOST = "control.example.com"
    try {
      await expect(assertDomainAvailable(makeDb(), "control.example.com"))
        .rejects.toBeInstanceOf(DomainCollisionError)
      await expect(assertDomainAvailable(makeDb(), "*.example.com"))
        .rejects.toBeInstanceOf(DomainCollisionError)
      await expect(assertDomainAvailable(makeDb(), "app.example.com"))
        .resolves.toBe("app.example.com")
    } finally {
      testEnv.PLOYDOK_PUBLIC_HOST = previousHost
    }
  })

  it("reserves configured control-plane hosts and the generated app namespace", async () => {
    const testEnv = env as {
      PLOYDOK_PUBLIC_HOST: string
      PLOYDOK_DOMAIN_BASE?: string
      WEB_ORIGIN: string
      PLOYDOK_REGISTRY_URL: string
      PLOYDOK_REGISTRY_API_URL?: string
      PLOYDOK_REGISTRY_PUSH_URL: string
    }
    const previous = {
      PLOYDOK_PUBLIC_HOST: testEnv.PLOYDOK_PUBLIC_HOST,
      PLOYDOK_DOMAIN_BASE: testEnv.PLOYDOK_DOMAIN_BASE,
      WEB_ORIGIN: testEnv.WEB_ORIGIN,
      PLOYDOK_REGISTRY_URL: testEnv.PLOYDOK_REGISTRY_URL,
      PLOYDOK_REGISTRY_API_URL: testEnv.PLOYDOK_REGISTRY_API_URL,
      PLOYDOK_REGISTRY_PUSH_URL: testEnv.PLOYDOK_REGISTRY_PUSH_URL,
    }
    Object.assign(testEnv, {
      PLOYDOK_PUBLIC_HOST: "control.example.com",
      PLOYDOK_DOMAIN_BASE: "apps.example.com",
      WEB_ORIGIN: "https://console.example.com",
      PLOYDOK_REGISTRY_URL: "registry.example.com:5000",
      PLOYDOK_REGISTRY_API_URL: "https://registry-api.example.com",
      PLOYDOK_REGISTRY_PUSH_URL: "registry-push.example.com:5000",
    })
    try {
      for (const hostname of [
        "control.example.com",
        "api.control.example.com",
        "registry.control.example.com",
        "adminer.control.example.com",
        "console.example.com",
        "registry.example.com",
        "registry-api.example.com",
        "registry-push.example.com",
        "apps.example.com",
        "*.apps.example.com",
      ]) {
        await expect(assertDomainAvailable(makeDb(), hostname)).rejects.toBeInstanceOf(
          DomainCollisionError
        )
      }
    } finally {
      Object.assign(testEnv, previous)
    }
  })

  it("returns the normalized hostname when all app, service, and domain owners are clear", async () => {
    await expect(
      assertDomainAvailable(makeDb(), "API.Example.com")
    ).resolves.toBe("api.example.com")
  })

  it("reports a wildcard custom domain collision across resource types", async () => {
    const db = makeDb({
      domains: [{ id: "domain-1", appId: "app-other", hostname: "*.example.com" }],
      services: [{ id: "service-1", hostname: "api.example.com" }],
    })

    await expect(
      findDomainCollisions(db, "api.example.com")
    ).resolves.toEqual([
      {
        resource: "domain",
        resourceId: "domain-1",
        hostname: "*.example.com",
      },
      {
        resource: "service",
        resourceId: "service-1",
        hostname: "api.example.com",
      },
    ])
    const error = await assertDomainAvailable(db, "api.example.com").catch(
      (value: unknown) => value
    )
    expect(error).toBeInstanceOf(DomainCollisionError)
    expect((error as DomainCollisionError).code).toBe("DOMAIN_CONFLICT")
    expect((error as DomainCollisionError).collisions).toEqual([
      {
        resource: "domain",
        resourceId: "domain-1",
        hostname: "*.example.com",
      },
      {
        resource: "service",
        resourceId: "service-1",
        hostname: "api.example.com",
      },
    ])
  })

  it("allows an app to re-check its own hostname while excluding that app", async () => {
    const db = makeDb({ apps: [{ id: "app-1", hostname: "app.example.com" }] })
    await expect(
      assertDomainAvailable(db, "app.example.com", { excludeAppId: "app-1" })
    ).resolves.toBe("app.example.com")
  })

  it("rejects malformed hostnames before querying owners", async () => {
    await expect(assertDomainAvailable(makeDb(), "not a hostname")).rejects.toBeInstanceOf(
      InvalidAppDomainError
    )
  })
})

describe("unique domain constraint classification", () => {
  it("recognizes the domain ownership constraints", () => {
    expect(
      isUniqueDomainConstraintError({
        code: "23505",
        message: "duplicate key violates apps_domain_unique",
      })
    ).toBe(true)
    expect(
      isUniqueDomainConstraintError({
        code: "23505",
        message: "duplicate key violates domains_hostname_unique",
      })
    ).toBe(true)
    expect(
      isUniqueDomainConstraintError({
        code: "23505",
        message: "duplicate key violates unrelated_constraint",
      })
    ).toBe(false)
  })
})
