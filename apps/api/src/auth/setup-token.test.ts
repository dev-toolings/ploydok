// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { env } from "../env"
import {
  __resetSetupTokenForTest,
  bootstrapSetupToken,
  clearSetupToken,
  consumeSetupToken,
  getSetupTokenState,
  getSetupTokenValue,
  setupSessionMaxAge,
  validateSetupToken,
} from "./setup-token"
import type { Db } from "@ploydok/db"

function makeDb(userCount: number): Db {
  return {
    select: () => ({
      from: () => ({
        limit: async () =>
          Array.from({ length: userCount }, (_, i) => ({ id: `u${i}` })),
      }),
    }),
  } as unknown as Db
}

describe("setup-token", () => {
  const testEnv = env as { PLOYDOK_SETUP_TOKEN_REQUIRED: boolean }
  let tokenRequired = testEnv.PLOYDOK_SETUP_TOKEN_REQUIRED

  beforeEach(() => {
    tokenRequired = testEnv.PLOYDOK_SETUP_TOKEN_REQUIRED
    testEnv.PLOYDOK_SETUP_TOKEN_REQUIRED = true
    __resetSetupTokenForTest()
    delete Bun.env["PLOYDOK_SETUP_TOKEN"]
  })

  afterEach(() => {
    testEnv.PLOYDOK_SETUP_TOKEN_REQUIRED = tokenRequired
  })

  test("leaves setup open when the token lock is off", async () => {
    testEnv.PLOYDOK_SETUP_TOKEN_REQUIRED = false
    await bootstrapSetupToken(makeDb(0))
    expect(getSetupTokenState().active).toBe(false)
  })

  test("does not generate a token when users already exist", async () => {
    await bootstrapSetupToken(makeDb(1))
    expect(getSetupTokenState().active).toBe(false)
  })

  test("generates a single-use token on empty DB", async () => {
    await bootstrapSetupToken(makeDb(0))
    expect(getSetupTokenState().active).toBe(true)
  })

  test("rejects mismatched tokens", async () => {
    await bootstrapSetupToken(makeDb(0))
    expect(consumeSetupToken("wrong")).toBe(false)
    expect(consumeSetupToken(undefined)).toBe(false)
  })

  test("clearSetupToken disables further consumption", async () => {
    await bootstrapSetupToken(makeDb(0))
    clearSetupToken()
    expect(getSetupTokenState().active).toBe(false)
  })

  test("env override has no expiry but is consumed once", async () => {
    Bun.env["PLOYDOK_SETUP_TOKEN"] = "x".repeat(32)
    await bootstrapSetupToken(makeDb(0))
    const state = getSetupTokenState()
    expect(state.active).toBe(true)
    expect(state.expires_at).toBeNull()
    expect(validateSetupToken("x".repeat(32))).toBe(true)
    expect(validateSetupToken("x".repeat(32))).toBe(true)
    expect(consumeSetupToken("x".repeat(32))).toBe(true)
    expect(consumeSetupToken("x".repeat(32))).toBe(false)
    expect(getSetupTokenState().active).toBe(false)
  })

  test("reports where the live token came from", async () => {
    await bootstrapSetupToken(makeDb(0))
    expect(getSetupTokenState().source).toBe("generated")

    __resetSetupTokenForTest()
    Bun.env["PLOYDOK_SETUP_TOKEN"] = "y".repeat(32)
    await bootstrapSetupToken(makeDb(0))
    expect(getSetupTokenState().source).toBe("env")

    clearSetupToken()
    expect(getSetupTokenState().source).toBeNull()
  })

  // Une valeur trop courte est ignorée sans erreur : l'API sert alors un token
  // aléatoire, et une URL construite depuis .env.local partirait en 403.
  test("falls back to a generated token when the env value is too short", async () => {
    Bun.env["PLOYDOK_SETUP_TOKEN"] = "tooshort"
    await bootstrapSetupToken(makeDb(0))
    const state = getSetupTokenState()
    expect(state.source).toBe("generated")
    expect(validateSetupToken("tooshort")).toBe(false)
  })

  test("caps the setup cookie lifetime even for a permanent token", async () => {
    Bun.env["PLOYDOK_SETUP_TOKEN"] = "z".repeat(32)
    await bootstrapSetupToken(makeDb(0))
    expect(getSetupTokenState().expires_at).toBeNull()
    expect(setupSessionMaxAge()).toBe(30 * 60)
  })

  test("exposes no cookie value once the token is gone", async () => {
    await bootstrapSetupToken(makeDb(0))
    expect(getSetupTokenValue()).toBeString()
    clearSetupToken()
    expect(getSetupTokenValue()).toBeNull()
    expect(setupSessionMaxAge()).toBe(0)
  })

  test("bootstrap is idempotent", async () => {
    await bootstrapSetupToken(makeDb(0))
    const first = getSetupTokenState()
    await bootstrapSetupToken(makeDb(0))
    const second = getSetupTokenState()
    expect(first.expires_at).toBe(second.expires_at)
  })
})
