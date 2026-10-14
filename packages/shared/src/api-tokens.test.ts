// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test"
import { tokenHasScope, ApiTokenCreateSchema } from "./api-tokens"

describe("tokenHasScope", () => {
  test("admin:* couvre tout", () => {
    expect(tokenHasScope(["admin:*"], "apps:read")).toBe(true)
    expect(tokenHasScope(["admin:*"], "secrets:write")).toBe(true)
    expect(tokenHasScope(["admin:*"], "databases:read")).toBe(true)
  })

  test("match exact", () => {
    expect(tokenHasScope(["apps:deploy"], "apps:deploy")).toBe(true)
    expect(tokenHasScope(["apps:deploy"], "apps:read")).toBe(false)
    expect(tokenHasScope(["apps:read"], "secrets:read")).toBe(false)
  })

  test("wildcard ressource", () => {
    expect(tokenHasScope(["databases:*"], "databases:read")).toBe(true)
    expect(tokenHasScope(["databases:*"], "databases:write")).toBe(true)
    expect(tokenHasScope(["databases:*"], "apps:read")).toBe(false)
  })

  test("scopes vides ⇒ refus", () => {
    expect(tokenHasScope([], "apps:read")).toBe(false)
  })

  test("scopes multiples", () => {
    const scopes = ["apps:read", "apps:deploy"]
    expect(tokenHasScope(scopes, "apps:read")).toBe(true)
    expect(tokenHasScope(scopes, "apps:deploy")).toBe(true)
    expect(tokenHasScope(scopes, "apps:write")).toBe(false)
    expect(tokenHasScope(scopes, "secrets:read")).toBe(false)
  })
})

describe("ApiTokenCreateSchema", () => {
  test("accepte name seul", () => {
    const r = ApiTokenCreateSchema.safeParse({ name: "ci-deploy" })
    expect(r.success).toBe(true)
  })

  test("accepte scopes valides", () => {
    const r = ApiTokenCreateSchema.safeParse({
      name: "ci",
      scopes: ["apps:read", "apps:deploy", "services:read", "services:write"],
    })
    expect(r.success).toBe(true)
  })

  test("rejette scope inconnu", () => {
    const r = ApiTokenCreateSchema.safeParse({
      name: "x",
      scopes: ["banana:read"],
    })
    expect(r.success).toBe(false)
  })

  test("rejette scopes vide", () => {
    const r = ApiTokenCreateSchema.safeParse({ name: "x", scopes: [] })
    expect(r.success).toBe(false)
  })
})
