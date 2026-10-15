// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { appHasLiveRuntime } from "./apps-volumes"

describe("appHasLiveRuntime", () => {
  it("treats a Swarm service as live even when container_id is null", () => {
    expect(
      appHasLiveRuntime({
        status: "running",
        container_id: null,
        swarm_service_name: "ploydok-app-demo-abc",
      })
    ).toBe(true)
  })

  it("ignores a stopped Swarm app", () => {
    expect(
      appHasLiveRuntime({
        status: "stopped",
        container_id: null,
        swarm_service_name: "ploydok-app-demo-abc",
      })
    ).toBe(false)
  })

  it("still detects leftover docker runtimes", () => {
    expect(
      appHasLiveRuntime({
        status: "running",
        container_id: "ploydok-app-demo-abc-green",
        swarm_service_name: null,
      })
    ).toBe(true)
  })
})
