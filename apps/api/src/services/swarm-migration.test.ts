// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { apps } from "@ploydok/db"

let routeApplied = false
const stoppedContainers: string[] = []

mock.module("../worker/swarm-runner.js", () => ({
  loadRuntimeEnv: async () => ({}),
  runSwarmDeploy: async () => ({
    serviceName: "ploydok-app-demo",
    runtimeRef: "ploydok-app-demo",
    routeApplied,
  }),
}))

mock.module("../worker/runner.js", () => ({
  stopContainer: async (_agent: unknown, containerId: string) => {
    stoppedContainers.push(containerId)
  },
}))

mock.module("../agent/client.js", () => ({
  createAgentClient: () => ({ close() {} }),
}))

const appRow = {
  id: "app-1",
  container_id: "old-docker-container",
  runtime_port: 3000,
}

function makeDb() {
  return {
    select() {
      return {
        from(table: unknown) {
          if (table === apps) {
            return {
              where: async () => [appRow],
            }
          }
          return {
            where() {
              return {
                orderBy() {
                  return {
                    limit: async () => [
                      { image_tag: "registry.example/app:latest" },
                    ],
                  }
                },
              }
            },
          }
        },
      }
    },
  }
}

describe("Docker to Swarm migration route gate", () => {
  it("retains the old Docker container when the primary route is DNS-blocked", async () => {
    routeApplied = false
    stoppedContainers.length = 0
    const { migrateDockerAppsToSwarmOnBoot } = await import("./swarm-migration")

    await expect(migrateDockerAppsToSwarmOnBoot(makeDb() as never)).resolves.toEqual({
      attempted: 1,
      migrated: 1,
      skipped: 0,
      failed: 0,
    })
    expect(stoppedContainers).toEqual([])
  })

  it("stops the old Docker container after the Swarm route is applied", async () => {
    routeApplied = true
    stoppedContainers.length = 0
    const { migrateDockerAppsToSwarmOnBoot } = await import("./swarm-migration")

    await expect(migrateDockerAppsToSwarmOnBoot(makeDb() as never)).resolves.toEqual({
      attempted: 1,
      migrated: 1,
      skipped: 0,
      failed: 0,
    })
    expect(stoppedContainers).toEqual(["old-docker-container"])
  })
})
