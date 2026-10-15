// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, mock } from "bun:test"
import type { Db } from "@ploydok/db"
import { userMaxScopes, assertScopesAllowed } from "./scope-rbac"

describe("userMaxScopes", () => {
  let mockDb: Db

  beforeEach(() => {
    mockDb = {
      select: mock((fields) => ({
        from: mock((table) => ({
          where: mock((condition) => ({
            __isSelectPromise: true,
            then: mock(async () => []),
          })),
        })),
      })),
    } as any
  })

  it("should return admin:* for owner role", async () => {
    mockDb = {
      select: mock((fields) => ({
        from: mock((table) => ({
          where: mock((condition) => ({
            then: mock(async (cb: any) => {
              cb([{ role: "owner" }])
            }),
          })),
        })),
      })),
    } as any

    const scopes = await userMaxScopes(mockDb, "user-1")
    expect(scopes).toEqual(["admin:*"])
  })

  it("should return admin scopes (except admin:*) for admin role", async () => {
    mockDb = {
      select: mock((fields) => ({
        from: mock((table) => ({
          where: mock((condition) => ({
            then: mock(async (cb: any) => {
              cb([{ role: "admin" }])
            }),
          })),
        })),
      })),
    } as any

    const scopes = await userMaxScopes(mockDb, "user-1")
    expect(scopes).toContain("apps:read")
    expect(scopes).toContain("databases:*")
    expect(scopes).not.toContain("admin:*")
  })

  it("should return member scopes when user is member only", async () => {
    mockDb = {
      select: mock((fields) => ({
        from: mock((table) => ({
          where: mock((condition) => ({
            then: mock(async (cb: any) => {
              cb([{ role: "member" }])
            }),
          })),
        })),
      })),
    } as any

    const scopes = await userMaxScopes(mockDb, "user-1")
    expect(scopes).toEqual(["apps:read", "databases:read", "storage:read"])
  })

  it("should return guest scopes when user has only guest role", async () => {
    mockDb = {
      select: mock((fields) => ({
        from: mock((table) => ({
          where: mock((condition) => ({
            then: mock(async (cb: any) => {
              cb([{ role: "guest" }])
            }),
          })),
        })),
      })),
    } as any

    const scopes = await userMaxScopes(mockDb, "user-1")
    expect(scopes).toEqual(["apps:read"])
  })

  it("should return max role scopes when user has multiple roles across orgs", async () => {
    mockDb = {
      select: mock((fields) => ({
        from: mock((table) => ({
          where: mock((condition) => ({
            then: mock(async (cb: any) => {
              cb([{ role: "member" }, { role: "admin" }])
            }),
          })),
        })),
      })),
    } as any

    const scopes = await userMaxScopes(mockDb, "user-1")
    expect(scopes).not.toContain("admin:*")
    expect(scopes).toContain("databases:*")
  })

  it("should return guest scopes when user has no memberships", async () => {
    mockDb = {
      select: mock((fields) => ({
        from: mock((table) => ({
          where: mock((condition) => ({
            then: mock(async (cb: any) => {
              cb([])
            }),
          })),
        })),
      })),
    } as any

    const scopes = await userMaxScopes(mockDb, "user-1")
    expect(scopes).toEqual(["apps:read"])
  })
})

describe("assertScopesAllowed", () => {
  it("should allow admin:* when allowed contains admin:*", () => {
    const result = assertScopesAllowed(
      ["apps:read", "databases:write"],
      ["admin:*"]
    )
    expect(result.ok).toBe(true)
  })

  it("should deny admin:* when user is not owner", () => {
    const result = assertScopesAllowed(
      ["admin:*"],
      ["apps:read", "apps:write", "databases:read"]
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.denied).toContain("admin:*")
  })

  it("should allow apps:read when explicitly in allowed", () => {
    const result = assertScopesAllowed(
      ["apps:read"],
      ["apps:read", "apps:write"]
    )
    expect(result.ok).toBe(true)
  })

  it("should allow databases:read when databases:* is in allowed", () => {
    const result = assertScopesAllowed(["databases:read"], ["databases:*"])
    expect(result.ok).toBe(true)
  })

  it("should deny secrets:write when only apps:read is allowed", () => {
    const result = assertScopesAllowed(["secrets:write"], ["apps:read"])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.denied).toContain("secrets:write")
  })

  it("should return multiple denied scopes", () => {
    const result = assertScopesAllowed(
      ["admin:*", "secrets:write"],
      ["apps:read"]
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.denied.length).toBe(2)
  })
})
