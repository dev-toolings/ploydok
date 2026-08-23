// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { DOCKER_CLEANUP_GATE_HEARTBEAT_MS, DOCKER_CLEANUP_GATE_TTL_MS, persistDockerCleanupProgress } from "./gc-docker"

describe("Docker cleanup distributed lock", () => {
  it("renews the writer gate with at least two retry windows before expiry", () => {
    expect(DOCKER_CLEANUP_GATE_HEARTBEAT_MS).toBeLessThan(DOCKER_CLEANUP_GATE_TTL_MS / 2)
  })
})

describe("Docker cleanup progressive persistence", () => {
  it("writes completed stages before a later stage can fail", async () => {
    const set = mock(() => ({ where: mock(() => Promise.resolve()) }))
    const db = { update: mock(() => ({ set })) } as any
    const result = { docker: { status: "succeeded" }, localCaches: { status: "pending" } }
    await persistDockerCleanupProgress(db, "job-1", result)
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ result })
  })
})
