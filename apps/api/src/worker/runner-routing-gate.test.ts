// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "node:events"

let routeMode: "dns-soft" | "ready" | "primary-throw" = "dns-soft"
const caddyUpstreams: Array<{ host: string; port: number }> = []
const stoppedContainers: string[] = []
const removedContainers: string[] = []
let currentContainerId = "old-blue"
let activeCaddyUpstream: { host: string; port: number } | null = null
let reconciliationOwned = true

mock.module("@ploydok/agent-proto", () => {
  class AgentClient {
    imagePull() {
      const stream = new EventEmitter()
      queueMicrotask(() => stream.emit("end"))
      return stream
    }

    containerCreate(
      _request: unknown,
      callback: (error: null, response: { containerId: string }) => void
    ) {
      callback(null, { containerId: "new-container" })
      return {}
    }

    containerStart(
      _request: unknown,
      callback: (error: null, response: object) => void
    ) {
      callback(null, {})
      return {}
    }

    inspectContainerHealth(
      _request: unknown,
      callback: (error: null, response: object) => void
    ) {
      callback(null, {
        status: 1,
        failingStreak: 0,
        lastProbeOutput: "",
        containerMissing: false,
        running: true,
        state: "running",
      })
      return {}
    }

    containerStop(
      request: { containerId: string },
      callback: (error: null, response: object) => void
    ) {
      stoppedContainers.push(request.containerId)
      callback(null, {})
      return {}
    }

    containerRemove(
      request: { containerId: string },
      callback: (error: null, response: object) => void
    ) {
      removedContainers.push(request.containerId)
      callback(null, {})
      return {}
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
    async setUpstream(
      _appId: string,
      _host: string,
      upstream: { host: string; port: number }
    ) {
      const next = { ...upstream }
      caddyUpstreams.push(next)
      activeCaddyUpstream = next
    }

    async getUpstream() {
      return activeCaddyUpstream
    }

    async getRouteHost() {
      return null
    }

    async removeUpstream() {}
  },
}))

mock.module("../domains/routing.js", () => ({
  publishHealthyAppRoute: async (input: {
    applyRoute: () => Promise<void>
  }) => {
    if (routeMode === "dns-soft") {
      return {
        status: "action_required",
        hostname: "custom.example.com",
        routeApplied: false,
        dnsStatus: "missing",
        tlsStatus: "pending",
        error: "DOMAIN_DNS_REQUIRED",
      }
    }
    if (routeMode === "primary-throw") {
      await input.applyRoute()
      throw new Error("primary route failed")
    }
    await input.applyRoute()
    return {
      status: "ready",
      hostname: "custom.example.com",
      routeApplied: true,
      dnsStatus: "valid",
      tlsStatus: "not_required",
      error: null,
    }
  },
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

mock.module("../services/projects.js", () => ({
  ensureProjectNetwork: async () => "ploydok-project-1",
  networksForApp: () => ["ploydok-project-1"],
}))

mock.module("../caddy/attachment.js", () => ({
  ensureCaddyOnProjectNetwork: async () => {},
}))

mock.module("../debug/singletons.js", () => ({
  getSharedAgent: () => ({}),
}))

mock.module("../services/app-volumes.js", () => ({
  listRuntimeAppVolumeMounts: async () => [],
}))

mock.module("../cloudflare/purge.js", () => ({
  purgeCloudflareForApp: async () => {},
}))

mock.module("./app-deploy-lock.js", () => ({
  currentDeployLease: () => undefined,
  currentDeployLeaseCondition: () => undefined,
  DeployLeaseLostError: class DeployLeaseLostError extends Error {},
  fenceDeploySideEffect: async () => {},
  runOwnedDeployReconciliation: async (action: () => Promise<void>) => {
    if (!reconciliationOwned) return false
    await action()
    return true
  },
}))

function makeDb(updates: Array<Record<string, unknown>>) {
  const app = {
    id: "app-1",
    get container_id() {
      return currentContainerId
    },
    slug: "demo",
    domain: "custom.example.com",
    restart_policy: "unless-stopped",
    runtime_port: 3000,
    healthcheck_path: "/",
    healthcheck_port: 3000,
    healthcheck_interval_s: 0,
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
    project_id: "project-1",
    owner_id: "user-1",
  }

  return {
    select() {
      const query = {
        from() {
          return query
        },
        innerJoin() {
          return query
        },
        where() {
          return query
        },
        limit: async () => [app],
        orderBy() {
          return { limit: async () => [] }
        },
      }
      return query
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values)
          return {
            where() {
              return {
                returning: async () => {
                  if (typeof values.container_id === "string") {
                    currentContainerId = values.container_id
                  }
                  return [{ id: "app-1" }]
                },
              }
            },
          }
        },
      }
    },
  }
}

describe("runBlueGreen routing gate", () => {
  it("retains the old container when DNS soft-fails before the primary route is applied", async () => {
    routeMode = "dns-soft"
    reconciliationOwned = true
    currentContainerId = "old-blue"
    activeCaddyUpstream = null
    caddyUpstreams.length = 0
    stoppedContainers.length = 0
    removedContainers.length = 0
    const updates: Array<Record<string, unknown>> = []
    const { runBlueGreen } = await import("./runner.js")

    await runBlueGreen({
      appId: "app-1",
      imageRef: "registry.example/app:latest",
      env: {},
      db: makeDb(updates) as never,
    })

    expect(caddyUpstreams).toEqual([])
    expect(stoppedContainers).toEqual([])
    expect(removedContainers).toEqual([])
    expect(updates).toContainEqual(
      expect.objectContaining({ container_id: expect.stringContaining("green") })
    )
  })

  it("compensates the new container and restores Caddy after a primary route throw", async () => {
    routeMode = "primary-throw"
    reconciliationOwned = true
    currentContainerId = "old-blue"
    activeCaddyUpstream = { host: "old-blue", port: 3000 }
    caddyUpstreams.length = 0
    stoppedContainers.length = 0
    removedContainers.length = 0
    const updates: Array<Record<string, unknown>> = []
    const { runBlueGreen } = await import("./runner.js")

    await expect(
      runBlueGreen({
        appId: "app-1",
        imageRef: "registry.example/app:latest",
        env: {},
        db: makeDb(updates) as never,
      })
    ).rejects.toThrow("primary route failed")

    expect(caddyUpstreams).toEqual([
      { host: expect.stringContaining("green"), port: 3000 },
      { host: "old-blue", port: 3000 },
    ])
    expect(stoppedContainers).toContain("new-container")
    expect(removedContainers).toContain("new-container")
    expect(updates).toEqual([])
  })

  it("keeps Caddy's active old slot safe across a later deploy after DNS gating", async () => {
    const originalSetTimeout = globalThis.setTimeout
    routeMode = "dns-soft"
    reconciliationOwned = true
    currentContainerId = "ploydok-app-app-1-blue"
    activeCaddyUpstream = {
      host: "ploydok-app-demo-app-1-blue",
      port: 3000,
    }
    caddyUpstreams.length = 0
    stoppedContainers.length = 0
    removedContainers.length = 0
    const updates: Array<Record<string, unknown>> = []
    const { runBlueGreen } = await import("./runner.js")

    globalThis.setTimeout = ((callback: unknown, ...args: Array<unknown>) => {
      if (typeof callback === "function") callback(...args)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    try {
      await runBlueGreen({
        appId: "app-1",
        imageRef: "registry.example/app:latest",
        env: {},
        db: makeDb(updates) as never,
      })
      routeMode = "ready"
      await runBlueGreen({
        appId: "app-1",
        imageRef: "registry.example/app:next",
        env: {},
        db: makeDb(updates) as never,
      })
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    expect(caddyUpstreams).toEqual([
      { host: "ploydok-app-demo-app-1-green", port: 3000 },
    ])
    expect(stoppedContainers).toEqual([
      "ploydok-app-demo-app-1-blue",
      "ploydok-app-app-1-blue",
    ])
    expect(removedContainers).toEqual(stoppedContainers)
  })

  it("does not restore Caddy when deploy reconciliation ownership is lost", async () => {
    routeMode = "primary-throw"
    reconciliationOwned = false
    currentContainerId = "old-blue"
    activeCaddyUpstream = { host: "old-blue", port: 3000 }
    caddyUpstreams.length = 0
    stoppedContainers.length = 0
    removedContainers.length = 0
    const updates: Array<Record<string, unknown>> = []
    const { runBlueGreen } = await import("./runner.js")

    try {
      await expect(
        runBlueGreen({
          appId: "app-1",
          imageRef: "registry.example/app:latest",
          env: {},
          db: makeDb(updates) as never,
        })
      ).rejects.toThrow("primary route failed")
    } finally {
      reconciliationOwned = true
    }

    expect(caddyUpstreams).toEqual([
      { host: expect.stringContaining("green"), port: 3000 },
    ])
    expect(stoppedContainers).toEqual([])
    expect(removedContainers).toEqual([])
  })
})
