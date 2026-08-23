// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { acquireGate } from "./build-cleanup-gate"

describe("build/cleanup gate", () => {
  it("uses atomic writer/readers scripts for both interleavings", async () => {
    const redis = { eval: mock(() => Promise.resolve(1)) }
    const cleanup = await acquireGate(redis, "writer", "cleanup")
    expect(cleanup).not.toBeNull()
    await cleanup!.renew()
    await cleanup!.release()
    const deploy = await acquireGate(redis, "reader", "deploy")
    expect(deploy).not.toBeNull()
  })

  it("refuses a contender and reports renewal loss", async () => {
    const redis = { eval: mock(() => Promise.resolve(0)) }
    expect(await acquireGate(redis, "writer", "cleanup")).toBeNull()
  })

  it("models both cleanup/deploy contention interleavings", async () => {
    const state = { writer: false, readers: 0 }
    const redis = { eval: mock((_script: string, _keys: number, _key: string, _now: string, _ttl: string, mode: string) => {
      if (mode === "writer") { if (state.writer || state.readers) return Promise.resolve(0); state.writer = true; return Promise.resolve(1) }
      if (state.writer) return Promise.resolve(0)
      state.readers += 1; return Promise.resolve(1)
    }) }
    expect(await acquireGate(redis, "writer", "cleanup")).not.toBeNull()
    expect(await acquireGate(redis, "reader", "deploy")).toBeNull()
  })
})
