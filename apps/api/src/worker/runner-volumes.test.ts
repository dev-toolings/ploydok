// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "node:events"

const containerCreateCalls: Array<unknown> = []
const listRuntimeAppVolumeMounts = mock(async () => [
  {
    id: "vol-1",
    name: "data",
    mountPath: "/data",
    hostPath: "/var/lib/ploydok/app-volumes/app-1/vol-1",
    sizeLimitBytes: null,
    readOnly: false,
  },
])

mock.module("@ploydok/agent-proto", () => {
  class AgentClient {
    imagePull() {
      const stream = new EventEmitter()
      queueMicrotask(() => {
        stream.emit("data", { status: "done" })
        stream.emit("end")
      })
      return stream as unknown
    }

    containerCreate(
      req: unknown,
      cb: (err: null, res: { containerId: string }) => void
    ) {
      containerCreateCalls.push(req)
      cb(null, { containerId: "ctr-new" })
      return {} as unknown
    }

    containerStart(_req: unknown, cb: (err: null, res: object) => void) {
      cb(null, {})
      return {} as unknown
    }

    inspectContainerHealth(
      _req: unknown,
      cb: (err: null, res: object) => void
    ) {
      cb(null, {
        status: 1,
        failingStreak: 0,
        lastProbeOutput: "",
        containerMissing: false,
      })
      return {} as unknown
    }

    containerStop(_req: unknown, cb: (err: null, res: object) => void) {
      cb(null, {})
      return {} as unknown
    }

    containerRemove(_req: unknown, cb: (err: null, res: object) => void) {
      cb(null, {})
      return {} as unknown
    }

    close() {}
  }

  return {
    AgentClient,
    ContainerHealthStatus: {
      CONTAINER_HEALTH_STATUS_NONE: 0,
      CONTAINER_HEALTH_STATUS_HEALTHY: 1,
      CONTAINER_HEALTH_STATUS_UNHEALTHY: 2,
      CONTAINER_HEALTH_STATUS_STARTING: 3,
    },
  }
})

mock.module("../caddy/client.js", () => ({
  CaddyClient: class {
    async setUpstream() {}
    async removeUpstream() {}
  },
}))

mock.module("../services/projects.js", () => ({
  ensureProjectNetwork: async () => "ploydok-proj-1",
  networksForApp: () => ["ploydok-proj-1"],
}))

mock.module("../caddy/attachment.js", () => ({
  ensureCaddyOnProjectNetwork: async () => {},
}))

mock.module("../debug/singletons.js", () => ({
  getSharedAgent: () => ({}),
}))

mock.module("../cloudflare/purge.js", () => ({
  purgeCloudflareForApp: async () => {},
}))

// The real module opens a Redis connection at import time; outside a lease
// these helpers are no-ops, so stub them to keep the test off the network.
mock.module("./app-deploy-lock.js", () => ({
  DeployLeaseLostError: class DeployLeaseLostError extends Error {},
  currentDeployLease: () => undefined,
  currentDeployLeaseCondition: () => undefined,
  fenceDeploySideEffect: async () => {},
  runOwnedDeployReconciliation: async (action: () => Promise<void>) => {
    await action()
    return true
  },
}))

mock.module("../services/app-volumes.js", () => ({
  listRuntimeAppVolumeMounts,
}))

describe("runBlueGreen volumes wiring", () => {
  const originalSetTimeout = globalThis.setTimeout

  beforeEach(() => {
    containerCreateCalls.length = 0
    listRuntimeAppVolumeMounts.mockClear()
    globalThis.setTimeout = ((callback: unknown, ...args: Array<unknown>) => {
      if (typeof callback === "function") {
        callback(...args)
      }
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof globalThis.setTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it("forwards persistent app volumes to agent.containerCreate", async () => {
    const { runBlueGreen } = await import("./runner.js")

    const db = {
      select(selection?: Record<string, unknown>) {
        const keys = Object.keys(selection ?? {})
        const isFullAppRow = keys.includes("owner_id")
        const isContainerProbe =
          keys.length === 1 && keys.includes("container_id")

        return {
          from() {
            return {
              innerJoin() {
                return this
              },
              where() {
                return {
                  limit() {
                    if (isFullAppRow) {
                      return Promise.resolve([
                        {
                          id: "app-1",
                          slug: "demo-app",
                          domain: "demo.ploydok.local",
                          restart_policy: "unless-stopped",
                          runtime_port: 3000,
                          healthcheck_path: "/",
                          healthcheck_port: null,
                          healthcheck_interval_s: 1,
                          healthcheck_timeout_s: 1,
                          healthcheck_retries: 1,
                          healthcheck_start_period_s: 0,
                          plan: "custom",
                          cpu_limit: null,
                          mem_limit_bytes: null,
                          pids_limit: null,
                          cdn_mode: "off",
                          cdn_cache_ttl_s: null,
                          cdn_cache_paths: null,
                          cdn_compression: null,
                          cdn_image_optim: null,
                          cdn_headers: null,
                          cdn_external_provider: null,
                          project_id: "proj-1",
                          owner_id: "user-1",
                        },
                      ])
                    }

                    if (isContainerProbe) {
                      return Promise.resolve([{ container_id: null }])
                    }

                    return Promise.resolve([])
                  },
                  orderBy() {
                    return {
                      limit() {
                        return Promise.resolve([])
                      },
                    }
                  },
                }
              },
            }
          },
        }
      },
      update() {
        return {
          set() {
            return {
              where() {
                return {
                  returning() {
                    return Promise.resolve([{ id: "app-1" }])
                  },
                }
              },
            }
          },
        }
      },
    }

    await runBlueGreen({
      appId: "app-1",
      imageRef: "127.0.0.1:5000/app-app-1:latest",
      env: {},
      db: db as never,
      runtimePort: 3000,
    })

    expect(listRuntimeAppVolumeMounts).toHaveBeenCalledWith(db, "app-1", {
      ensureDirectories: true,
    })
    const req = containerCreateCalls[0] as {
      volumes?: Array<{
        hostPath: string
        containerPath: string
        readOnly: boolean
      }>
    }
    expect(req.volumes).toEqual([
      {
        hostPath: "/var/lib/ploydok/app-volumes/app-1/vol-1",
        containerPath: "/data",
        readOnly: false,
      },
    ])
  })
})
