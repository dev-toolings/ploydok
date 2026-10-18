// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import type { SwarmTaskSnapshot } from "@ploydok/agent-proto"
import { describeTasks, taskForLogs, taskIsHealthy } from "./swarm-runner"

function task(
  overrides: Partial<SwarmTaskSnapshot> = {}
): SwarmTaskSnapshot {
  return {
    id: "task-1",
    serviceName: "ploydok-app-demo",
    containerId: "container-1",
    slot: 1,
    image: "example/app:latest",
    desiredState: "running",
    status: "running",
    nodeId: "node-1",
    error: "",
    ...overrides,
  }
}

describe("taskIsHealthy", () => {
  it("requires a running task and the explicit healthy health status", () => {
    expect(
      taskIsHealthy(task({ running: true, healthStatus: "healthy" }))
    ).toBe(true)
    expect(
      taskIsHealthy(task({ running: false, healthStatus: "healthy" }))
    ).toBe(false)
    expect(
      taskIsHealthy(task({ running: true, healthStatus: "starting" }))
    ).toBe(false)
    expect(
      taskIsHealthy(task({ running: true, healthStatus: "unhealthy" }))
    ).toBe(false)
  })

  it("does not treat a running task without a healthy check as healthy", () => {
    expect(taskIsHealthy(task({ running: true, status: "running" }))).toBe(
      false
    )
    expect(
      taskIsHealthy(
        task({ running: true, status: "Up 1s (unhealthy)" })
      )
    ).toBe(false)
  })

  it("accepts a running task without a check only when health is not configured", () => {
    const runningWithoutCheck = task({
      running: true,
      status: "running",
      healthStatus: "none",
    })

    expect(taskIsHealthy(runningWithoutCheck, false)).toBe(true)
    expect(taskIsHealthy(runningWithoutCheck, true)).toBe(false)
    expect(
      taskIsHealthy(
        task({ running: true, status: "running", healthStatus: "unhealthy" }),
        false
      )
    ).toBe(false)
    expect(
      taskIsHealthy(
        task({ running: true, status: "running", healthStatus: "starting" }),
        false
      )
    ).toBe(false)
  })

  it("accepts the legacy Docker status format when no health field exists", () => {
    expect(
      taskIsHealthy(
        task({ running: true, status: "Up 1s (healthy)", healthStatus: undefined })
      )
    ).toBe(true)
    expect(
      taskIsHealthy(
        task({ running: false, status: "Up 1s (healthy)", healthStatus: undefined })
      )
    ).toBe(false)
    expect(
      taskIsHealthy(
        task({ status: "Up 1s (healthy)", healthStatus: undefined })
      )
    ).toBe(true)
  })
})

describe("rollout failure details", () => {
  const snapshot = (over: Partial<SwarmTaskSnapshot>): SwarmTaskSnapshot => ({
    id: "mrvw6cnw9x01sfgge6le3javl",
    serviceName: "ploydok-app-x",
    containerId: "952cf57a8488",
    slot: 1,
    image: "registry/app:sha",
    desiredState: "running",
    status: "Exited (1)",
    nodeId: "node",
    error: "",
    ...over,
  })

  it("summarizes each task instead of dumping the snapshot", () => {
    expect(
      describeTasks([
        snapshot({ state: "exited", running: false, exitCode: 1 }),
        snapshot({ id: "abcdefabcdefabcdef", state: "running", running: true, healthStatus: "unhealthy", error: "probe failed" }),
      ])
    ).toBe(
      "task mrvw6cnw9x01 state=exited exit=1; task abcdefabcdef state=running health=unhealthy error=probe failed"
    )
    expect(describeTasks([])).toBe("no task scheduled")
  })

  it("reads the logs of the stopped container first", () => {
    const running = snapshot({ containerId: "running", running: true, healthStatus: "starting" })
    const crashed = snapshot({ containerId: "crashed", running: false })
    const pending = snapshot({ containerId: "" })
    expect(taskForLogs([pending, running, crashed])?.containerId).toBe("crashed")
    expect(taskForLogs([pending])).toBeUndefined()
  })
})

