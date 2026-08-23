// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createRedis } from "@ploydok/db"
import { acquireGate } from "./build-cleanup-gate"

const key = `ploydok:test:build-cleanup-gate:${crypto.randomUUID()}`
const redis = createRedis("redis://127.0.0.1:6379")
beforeAll(async () => { await redis.del(key) })
afterAll(async () => { await redis.del(key); await redis.quit() })

describe("build/cleanup gate Redis", () => {
  it("enforces interleavings, expiry, renewal and owner fencing", async () => {
    const writer = await acquireGate(redis, "writer", "writer", { key, ttlMs: 100 })
    expect(writer).not.toBeNull()
    expect(await acquireGate(redis, "reader", "reader", { key, ttlMs: 100 })).toBeNull()
    expect(await writer!.renew()).toBe(true)
    await Bun.sleep(160)
    expect(await writer!.renew()).toBe(false)
    const reader = await acquireGate(redis, "reader", "reader", { key, ttlMs: 100 })
    expect(reader).not.toBeNull()
    expect(await acquireGate(redis, "writer", "writer-2", { key, ttlMs: 100 })).toBeNull()
    await reader!.release()
    expect(await acquireGate(redis, "writer", "writer-2", { key, ttlMs: 100 })).not.toBeNull()
  })
})
