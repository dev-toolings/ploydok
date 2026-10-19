// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { apps, builds } from "@ploydok/db"

const serviceUpdateImages: string[] = []
const serviceRollbacks: string[] = []
let serviceUpdateMode: "rpc-missing" | "async-missing" = "rpc-missing"
let serviceTaskPolls = 0

mock.module("@ploydok/agent-proto", () => {
  class AgentClient {
    serviceUpdateImage(
      request: { serviceName: string },
      callback: (error: { code: number; details: string } | null, response?: object) => void
    ) {
      serviceUpdateImages.push(request.serviceName)
      if (serviceUpdateMode === "rpc-missing") {
        callback({ code: 5, details: "manifest unknown" })
      } else {
        callback(null, {})
      }
      return {}
    }

    serviceRollback(
      request: { serviceName: string },
      callback: (error: null, response: object) => void
    ) {
      serviceRollbacks.push(request.serviceName)
      callback(null, {})
      return {}
    }

    listServiceTasks(
      _request: { serviceName: string },
      callback: (error: null, response: object) => void
    ) {
      serviceTaskPolls++
      if (serviceUpdateMode === "async-missing" && serviceTaskPolls === 1) {
        callback(null, {
          updateState: "updating",
          tasks: [
            {
              id: "task-1",
              serviceName: "ploydok-app-demo",
              containerId: "container-1",
              slot: 1,
              image: "registry.example/app:old",
              desiredState: "running",
              status: "rejected",
              running: false,
              healthStatus: "none",
              nodeId: "node-1",
              error: "manifest unknown",
              matchesServiceSpec: true,
            },
          ],
        })
        return {}
      }
      callback(null, {
        updateState: "rollback_completed",
        tasks: [
          {
            id: "task-1",
            serviceName: "ploydok-app-demo",
            containerId: "container-1",
            slot: 1,
            image: "registry.example/app:old",
            desiredState: "running",
            status: "running",
            running: true,
            healthStatus: "healthy",
            nodeId: "node-1",
            error: "",
            matchesServiceSpec: true,
          },
        ],
      })
      return {}
    }

    close() {}
  }

  return { AgentClient }
})

mock.module("../domains/routing.js", () => ({
  publishHealthyAppRoute: async () => ({
    status: "ready",
    hostname: "managed.example.com",
    routeApplied: false,
    dnsStatus: "unknown",
    tlsStatus: "pending",
    error: "DOMAIN_OWNERSHIP_REQUIRED",
  }),
  syncAppDomainAliases: async () => ({ updated: 0, errors: [] }),
}))

mock.module("../domains/availability.js", () => ({
  assertDomainAvailable: async () => {},
  withDomainLock: async (
    db: unknown,
    hostname: string,
    operation: (lockedDb: unknown, lockedHostname: string) => Promise<void>
  ) => operation(db, hostname),
}))

const app = {
  service: "ploydok-app-demo",
  domain: null,
  cdn_mode: "off",
  runtime_has_healthcheck: true,
  runtime_port: 3000,
  replicas: 1,
  update_parallelism: 1,
  update_delay_s: 10,
  update_monitor_s: 30,
  update_order: "start-first",
  failure_action: "rollback",
}

function makeDb(
  updates: Array<Record<string, unknown>>,
  buildRows: Array<Record<string, unknown>> = [
    {
      id: "build-current",
      image_tag: "registry.example/app:new",
      routing_domain: null,
    },
    {
      id: "build-previous",
      image_tag: "registry.example/app:old",
      routing_domain: null,
    },
  ]
) {
  return {
    select() {
      return {
        from(table: unknown) {
          const query = {
            where() {
              return query
            },
            limit: async (count?: number) =>
              table === apps
                ? [app]
                : count === 2
                  ? buildRows
                  : buildRows.slice(0, 1),
            orderBy() {
              return {
                limit: async () => buildRows,
              }
            },
          }
          return query
        },
      }
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values)
          return {
            where: async () => undefined,
          }
        },
      }
    },
  }
}

describe("rollbackSwarmApp image fallback", () => {
  it("uses the native Swarm rollback when the historical image is unavailable", async () => {
    serviceUpdateMode = "rpc-missing"
    serviceTaskPolls = 0
    serviceUpdateImages.length = 0
    serviceRollbacks.length = 0
    const updates: Array<Record<string, unknown>> = []
    const { rollbackSwarmApp } = await import("./swarm-runner")

    await rollbackSwarmApp("app-1", makeDb(updates) as never)

    expect(serviceUpdateImages).toEqual(["ploydok-app-demo"])
    expect(serviceRollbacks).toEqual(["ploydok-app-demo"])
    expect(updates).toContainEqual(
      expect.objectContaining({ status: "running" })
    )
  })

  it("uses the native Swarm rollback when no historical build is available", async () => {
    serviceUpdateMode = "rpc-missing"
    serviceTaskPolls = 0
    serviceUpdateImages.length = 0
    serviceRollbacks.length = 0
    const updates: Array<Record<string, unknown>> = []
    const { rollbackSwarmApp } = await import("./swarm-runner")

    await rollbackSwarmApp("app-1", makeDb(updates, []) as never)

    expect(serviceUpdateImages).toEqual([])
    expect(serviceRollbacks).toEqual(["ploydok-app-demo"])
  })

  it("falls back after an accepted update later reports a missing image", async () => {
    serviceUpdateMode = "async-missing"
    serviceTaskPolls = 0
    serviceUpdateImages.length = 0
    serviceRollbacks.length = 0
    const updates: Array<Record<string, unknown>> = []
    const { rollbackSwarmApp } = await import("./swarm-runner")

    await rollbackSwarmApp("app-1", makeDb(updates) as never)

    expect(serviceUpdateImages).toEqual(["ploydok-app-demo"])
    expect(serviceRollbacks).toEqual(["ploydok-app-demo"])
    expect(serviceTaskPolls).toBe(2)
  })
})
