// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "node:events"
import { apps, builds } from "@ploydok/db"

const events: string[] = []
const upstreams: Array<{ host: string; port: number }> = []
const updates: Array<Record<string, unknown>> = []
let healthStatus = 1
let domainCollision = false

mock.module("@ploydok/agent-proto", () => {
  class AgentClient {
    imagePull() {
      const stream = new EventEmitter()
      queueMicrotask(() => stream.emit("end"))
      return stream as unknown
    }

    containerCreate(
      _request: unknown,
      callback: (error: null, response: { containerId: string }) => void
    ) {
      events.push("create")
      callback(null, { containerId: "rollback-container" })
      return {} as unknown
    }

    containerStart(
      _request: unknown,
      callback: (error: null, response: object) => void
    ) {
      events.push("start")
      callback(null, {})
      return {} as unknown
    }

    inspectContainerHealth(
      _request: unknown,
      callback: (error: null, response: object) => void
    ) {
      events.push("health")
      callback(null, {
        status: healthStatus,
        failingStreak: 0,
        lastProbeOutput: "",
        containerMissing: false,
      })
      return {} as unknown
    }

    containerStop(
      _request: unknown,
      callback: (error: null, response: object) => void
    ) {
      events.push("stop")
      callback(null, {})
      return {} as unknown
    }

    containerRemove(
      _request: unknown,
      callback: (error: null, response: object) => void
    ) {
      events.push("remove")
      callback(null, {})
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
    async setUpstream(
      _appId: string,
      host: string,
      upstream: { host: string; port: number }
    ) {
      events.push(`route:${host}`)
      upstreams.push(upstream)
    }

    async getUpstream() {
      return null
    }
  },
}))

mock.module("../domains/routing.js", () => ({
  publishHealthyAppRoute: async (input: {
    hostname: string
    applyRoute: () => Promise<void>
  }) => {
    events.push(`route-check:${input.hostname}`)
    await input.applyRoute()
    return {
      status: "ready",
      hostname: input.hostname,
    routeApplied: true,
      dnsStatus: "valid",
      tlsStatus: "not_required",
      error: null,
    }
  },
  syncAppDomainAliases: async () => ({ updated: 0, errors: [] }),
}))

mock.module("../domains/availability.js", () => ({
  assertDomainAvailable: async () => {
    if (domainCollision) throw new Error("domain already claimed")
  },
  withDomainLock: async (
    db: unknown,
    hostname: string,
    operation: (lockedDb: unknown, lockedHostname: string) => Promise<void>
  ) => operation(db, hostname),
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

mock.module("../services/app-volumes.js", () => ({
  listRuntimeAppVolumeMounts: async () => [],
}))

mock.module("../secrets/resolver.js", () => ({
  buildEnvForDeploy: async () => ({}),
}))

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

function makeDb() {
  return {
    select(selection?: Record<string, unknown>) {
      const keys = Object.keys(selection ?? {})
      return {
        from(table: unknown) {
          const rows =
            keys.includes("routing_domain")
              ? [
                  {
                    id: "build-old",
                    image_tag: "registry.example/app:old",
                    container_id: null,
                    routing_domain: "old.example.com",
                  },
                ]
              : keys.includes("owner_id")
                ? [
                    {
                      id: "app-1",
                      slug: "demo-app",
                      domain: "current.example.com",
                      restart_policy: "unless-stopped",
                      runtime_port: 3000,
                      healthcheck_path: "/",
                      healthcheck_port: null,
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
                      project_id: "proj-1",
                      owner_id: "user-1",
                    },
                  ]
                : table === apps
                  ? [{ container_id: "ploydok-app-demo-app-blue" }]
                  : table === builds
                    ? []
                    : []

          return {
            innerJoin() {
              return this
            },
            where() {
              return {
                limit: async () => rows,
                orderBy() {
                  return { limit: async () => rows }
                },
              }
            },
          }
        },
      }
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values)
          return { where: async () => [] }
        },
      }
    },
  }
}

describe("rollbackApp routing gate", () => {
  const originalSetTimeout = globalThis.setTimeout

  beforeEach(() => {
    events.length = 0
    upstreams.length = 0
    updates.length = 0
    healthStatus = 1
    domainCollision = false
    globalThis.setTimeout = ((callback: unknown, ...args: Array<unknown>) => {
      if (typeof callback === "function") callback(...args)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it("restores the target build hostname only after the rollback is healthy", async () => {
    const { rollbackApp } = await import("./runner.js")

    await rollbackApp("app-1", makeDb() as never, "build-old")

    expect(events.indexOf("health")).toBeGreaterThanOrEqual(0)
    expect(events.indexOf("route-check:old.example.com")).toBeGreaterThan(
      events.indexOf("health")
    )
    expect(events).not.toContain("route-check:current.example.com")
    expect(upstreams).toEqual([
      { host: expect.stringContaining("-green"), port: 3000 },
    ])
    expect(updates).toContainEqual({
      container_id: expect.stringContaining("-green"),
      domain: "old.example.com",
      domain_source: "custom",
      status: "running",
      runtime_has_healthcheck: true,
      updated_at: expect.any(Date),
    })
  })

  it("does not publish the restored route when its runtime is unhealthy", async () => {
    const { rollbackApp } = await import("./runner.js")
    healthStatus = 2

    await expect(rollbackApp("app-1", makeDb() as never, "build-old")).rejects.toThrow(
      /did not become healthy/
    )

    expect(events).not.toContain("route-check:old.example.com")
    expect(events).toContain("stop")
  })

  it("stops the new rollback container when the restored domain collides", async () => {
    const { rollbackApp } = await import("./runner.js")
    domainCollision = true

    await expect(
      rollbackApp("app-1", makeDb() as never, "build-old")
    ).rejects.toThrow("domain already claimed")

    expect(events).toContain("stop")
    expect(events).not.toContain("route-check:old.example.com")
  })
})
