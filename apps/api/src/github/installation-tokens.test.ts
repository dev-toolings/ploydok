// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import * as realDb from "@ploydok/db"
import * as realQueries from "@ploydok/db/queries"
import * as realAppCredentials from "./app-credentials"
import * as realJwt from "./jwt"

let currentConfig: { app_id: string; pem_enc: Buffer; pem_nonce: Buffer } | null =
  null
let configReads = 0

mock.module("@ploydok/db", () => ({
  ...realDb,
  createDb: () => ({}),
}))

mock.module("@ploydok/db/queries", () => ({
  ...realQueries,
  getGitHubAppConfigForInstallation: async () => {
    configReads += 1
    return currentConfig
  },
}))

mock.module("./app-credentials", () => ({
  ...realAppCredentials,
  decryptAppPrivateKey: async () => "private-key",
}))

mock.module("./jwt", () => ({
  ...realJwt,
  signAppJwt: (_pem: string, appId: string) => `jwt:${appId}`,
}))

const {
  evictAllInstallationTokens,
  evictInstallationToken,
  getInstallationToken,
} = await import("./installation-tokens")

const realFetch = globalThis.fetch
let issuedTokens: string[] = []
let fetchCalls = 0
let onFetch: (() => void) | null = null

beforeEach(() => {
  currentConfig = {
    app_id: "app-1",
    pem_enc: Buffer.from("ciphertext"),
    pem_nonce: Buffer.from("nonce"),
  }
  configReads = 0
  issuedTokens = ["token-1", "token-2"]
  fetchCalls = 0
  onFetch = null
  evictAllInstallationTokens()
  globalThis.fetch = mock(async () => {
    const token = issuedTokens[fetchCalls] ?? `token-${fetchCalls + 1}`
    fetchCalls += 1
    onFetch?.()
    return new Response(
      JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }),
      { status: 201, headers: { "content-type": "application/json" } }
    )
  }) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe("getInstallationToken cache fencing", () => {
  it("never serves a cached token after the App config is deleted", async () => {
    expect(await getInstallationToken("42")).toBe("token-1")
    currentConfig = null

    await expect(getInstallationToken("42")).rejects.toThrow(
      "No GitHub App owns this installation"
    )
    expect(fetchCalls).toBe(1)
    expect(configReads).toBe(3)
  })

  it("invalidates a cached token when app_id changes", async () => {
    expect(await getInstallationToken("42")).toBe("token-1")
    currentConfig = {
      app_id: "app-2",
      pem_enc: Buffer.from("new-ciphertext"),
      pem_nonce: Buffer.from("new-nonce"),
    }

    expect(await getInstallationToken("42")).toBe("token-2")
    expect(fetchCalls).toBe(2)
    expect(configReads).toBe(4)
  })

  it("invalidates a cached token when the same App is re-imported", async () => {
    expect(await getInstallationToken("42")).toBe("token-1")
    currentConfig = {
      app_id: "app-1",
      pem_enc: Buffer.from("replacement-ciphertext"),
      pem_nonce: Buffer.from("replacement-nonce"),
    }

    expect(await getInstallationToken("42")).toBe("token-2")
    expect(fetchCalls).toBe(2)
    expect(configReads).toBe(4)
  })

  it("keeps the cached token when the current app_id is unchanged", async () => {
    expect(await getInstallationToken("42")).toBe("token-1")
    expect(await getInstallationToken("42")).toBe("token-1")

    expect(fetchCalls).toBe(1)
    expect(configReads).toBe(3)
  })

  it("does not expose a fresh token when config is deleted during fetch", async () => {
    onFetch = () => {
      currentConfig = null
    }

    await expect(getInstallationToken("42")).rejects.toThrow(
      "configuration changed"
    )
    expect(fetchCalls).toBe(1)
    expect(configReads).toBe(2)
  })
})

describe("token cache eviction", () => {
  it("exports per-installation and global eviction helpers", () => {
    expect(typeof evictInstallationToken).toBe("function")
    expect(typeof evictAllInstallationTokens).toBe("function")
  })
})
