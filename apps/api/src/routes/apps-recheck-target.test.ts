// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { ContainerHealthStatus } from "@ploydok/agent-proto"

let swarmTasks: Array<{
  status: string
  running: boolean
  healthStatus?: string
}> = []
let containerHealth = {
  status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY,
  running: true,
  containerMissing: false,
}

mock.module("../worker/swarm-runner", () => ({
  listSwarmTasks: async () => swarmTasks,
  taskIsHealthy: (task: (typeof swarmTasks)[number]) =>
    task.running === true && task.healthStatus === "healthy",
}))

mock.module("../debug/singletons", () => ({
  getSharedAgent: () => ({
    inspectContainerHealth: async () => containerHealth,
  }),
  getSharedCaddy: () => ({}),
}))

mock.module("../worker/handlers/build-static", () => ({
  caddyStaticRootForApp: (appId: string) => `/tmp/caddy/${appId}`,
  staticRootForApp: () => "/tmp",
}))

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    build_method: "nixpacks",
    status: "running",
    runtime_mode: "docker",
    runtime_port: 8080,
    container_id: "container-1",
    swarm_service_name: null,
    replicas: 1,
    static_spa_fallback: true,
    ...overrides,
  }
}

describe("resolveHealthyRecheckTarget", () => {
  it("returns the persisted healthy Docker container as the route target", async () => {
    const { resolveHealthyRecheckTarget } = await import("./apps")
    containerHealth = {
      status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY,
      running: true,
      containerMissing: false,
    }

    await expect(
      resolveHealthyRecheckTarget({} as never, app() as never)
    ).resolves.toEqual({
      kind: "proxy",
      upstream: { host: "container-1", port: 8080 },
    })
  })

  it("refuses to recover a route while the persisted Docker runtime is unhealthy", async () => {
    const { resolveHealthyRecheckTarget } = await import("./apps")
    containerHealth = {
      status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_UNHEALTHY,
      running: true,
      containerMissing: false,
    }

    await expect(
      resolveHealthyRecheckTarget({} as never, app() as never)
    ).rejects.toThrow("Runtime is not healthy")
  })

  it("requires every configured Swarm replica to be healthy", async () => {
    const { resolveHealthyRecheckTarget } = await import("./apps")
    swarmTasks = [
      { status: "Up 1s (healthy)", running: true, healthStatus: "healthy" },
    ]
    const swarmApp = app({
      runtime_mode: "swarm",
      swarm_service_name: "ploydok-app-demo",
      replicas: 2,
    })

    await expect(
      resolveHealthyRecheckTarget({} as never, swarmApp as never)
    ).rejects.toThrow("Runtime is not healthy")

    swarmTasks.push({
      status: "Up 1s (healthy)",
      running: true,
      healthStatus: "healthy",
    })
    await expect(
      resolveHealthyRecheckTarget({} as never, swarmApp as never)
    ).resolves.toEqual({
      kind: "proxy",
      upstream: { host: "ploydok-app-demo", port: 8080 },
    })
  })

  it("uses the static artifact as the persisted healthy target", async () => {
    const { resolveHealthyRecheckTarget } = await import("./apps")

    await expect(
      resolveHealthyRecheckTarget(
        {} as never,
        app({ build_method: "static", status: "serving" }) as never
      )
    ).resolves.toEqual({
      kind: "static",
      root: "/tmp/caddy/app-1",
      spaFallback: true,
    })
  })
})
