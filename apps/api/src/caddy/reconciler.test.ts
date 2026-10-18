// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import pino from "pino"
import { ContainerHealthStatus } from "@ploydok/agent-proto"
import { app_deploy_leases } from "@ploydok/db"
import {
  canRestoreAppRoute,
  reconcileCaddyRoutes,
  reconcileServiceRoutes,
  type AppForReconcile,
  type ServiceForReconcile,
} from "./reconciler.js"
import type { CaddyClient } from "./client.js"

const silentLogger = pino({ level: "silent" })

describe("canRestoreAppRoute", () => {
  test("allows generated hosts and previously verified custom hosts", () => {
    expect(
      canRestoreAppRoute({
        domain_source: "generated",
        routing_status: "action_required",
        routing_dns_status: null,
      })
    ).toBe(true)
    expect(
      canRestoreAppRoute({
        domain_source: "custom",
        routing_status: "ready",
        routing_dns_status: null,
      })
    ).toBe(true)
    expect(
      canRestoreAppRoute({
        domain_source: "custom",
        routing_status: "action_required",
        routing_dns_status: "valid",
      })
    ).toBe(true)
  })

  test("does not restore an unverified custom primary host", () => {
    expect(
      canRestoreAppRoute({
        domain_source: "custom",
        routing_status: "action_required",
        routing_dns_status: "missing",
      })
    ).toBe(false)
    expect(
      canRestoreAppRoute({
        domain_source: "custom",
        routing_status: "pending",
        routing_dns_status: null,
      })
    ).toBe(false)
  })

  test("does not resurrect a proxied custom host blocked before publication", () => {
    expect(
      canRestoreAppRoute({
        domain_source: "custom",
        routing_status: "action_required",
        routing_dns_status: "unknown",
      })
    ).toBe(false)
  })
})

// Le chemin publie dans la config Caddy est celui vu par le container, pas
// celui ou l'API ecrit : on le fige pour que le test decrive le contrat de
// prod et ne suive pas le default de dev (sous HOME).
const previousCaddyStaticRoot = Bun.env["PLOYDOK_CADDY_STATIC_ROOT"]
beforeAll(() => {
  Bun.env["PLOYDOK_CADDY_STATIC_ROOT"] = "/var/lib/ploydok/static"
})
afterAll(() => {
  if (previousCaddyStaticRoot === undefined)
    delete Bun.env["PLOYDOK_CADDY_STATIC_ROOT"]
  else Bun.env["PLOYDOK_CADDY_STATIC_ROOT"] = previousCaddyStaticRoot
})

function createFakeCaddy(overrides: Partial<FakeCaddyCalls> = {}): {
  caddy: CaddyClient
  calls: FakeCaddyCalls
} {
  const calls: FakeCaddyCalls = {
    bootstrap: 0,
    upserts: [],
    staticUpserts: [],
    bootstrapErrors: overrides.bootstrapErrors ?? 0,
    upsertErrorFor: overrides.upsertErrorFor ?? new Set(),
  }

  const caddy = {
    async ensureBootstrap() {
      calls.bootstrap++
      if (calls.bootstrap <= calls.bootstrapErrors) {
        throw new Error(`bootstrap failed (attempt ${calls.bootstrap})`)
      }
    },
    async setUpstream(
      appId: string,
      host: string,
      upstream: { host: string; port: number }
    ) {
      if (calls.upsertErrorFor.has(appId)) {
        throw new Error(`upstream failed for ${appId}`)
      }
      calls.upserts.push({ appId, host, upstream })
    },
    async upsertStaticRoute(opts: {
      appId: string
      host: string
      root: string
      spaFallback?: boolean
      cdn?: AppForReconcile
    }) {
      calls.staticUpserts.push(opts)
    },
  } as unknown as CaddyClient

  return { caddy, calls }
}

interface FakeCaddyCalls {
  bootstrap: number
  upserts: Array<{
    appId: string
    host: string
    upstream: { host: string; port: number }
  }>
  staticUpserts: Array<{
    appId: string
    host: string
    root: string
    spaFallback?: boolean
    cdn?: AppForReconcile
  }>
  bootstrapErrors: number
  upsertErrorFor: Set<string>
}

function app(
  overrides: Partial<AppForReconcile> & Pick<AppForReconcile, "id">
): AppForReconcile {
  return {
    ...overrides,
    id: overrides.id,
    slug: overrides.slug ?? "demo",
    domain:
      "domain" in overrides ? overrides.domain! : `${overrides.id}.test.local`,
    container_id:
      "container_id" in overrides
        ? overrides.container_id!
        : `ploydok-app-${overrides.id}-blue`,
    runtime_mode: overrides.runtime_mode ?? "docker",
    swarm_service_name: overrides.swarm_service_name ?? null,
    runtime_port: "runtime_port" in overrides ? overrides.runtime_port! : null,
    healthcheck_port:
      "healthcheck_port" in overrides ? overrides.healthcheck_port! : 3000,
    build_method: overrides.build_method ?? "nixpacks",
    static_spa_fallback: overrides.static_spa_fallback ?? null,
    cdn_mode: overrides.cdn_mode ?? "off",
    cdn_cache_ttl_s: overrides.cdn_cache_ttl_s ?? 300,
    cdn_cache_paths: overrides.cdn_cache_paths ?? [],
    cdn_compression: overrides.cdn_compression ?? false,
    cdn_image_optim: overrides.cdn_image_optim ?? false,
    cdn_headers: overrides.cdn_headers ?? null,
    cdn_external_provider: overrides.cdn_external_provider ?? null,
  }
}

function createFakeServiceCaddy(): {
  caddy: CaddyClient
  upserts: Array<{ host: string; upstream: string; appId: string; accessLogs?: boolean }>
} {
  const upserts: Array<{ host: string; upstream: string; appId: string }> = []
  const caddy = {
    async ensureBootstrap() {},
    async upsertRoute(input: (typeof upserts)[number]) {
      upserts.push(input)
    },
  } as unknown as CaddyClient
  return { caddy, upserts }
}

function makeReconcileDb(activeLease = false) {
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              const rows = (table === app_deploy_leases && activeLease
                ? [{ app_id: "a1" }]
                : []) as unknown as Array<Record<string, unknown>> & {
                limit: () => Promise<Array<Record<string, unknown>>>
                orderBy: () => {
                  limit: () => Promise<Array<Record<string, unknown>>>
                }
              }
              rows.limit = async () => rows
              rows.orderBy = () => ({ limit: async () => rows })
              return rows
            },
          }
        },
      }
    },
    update() {
      return {
        set() {
          return { where: async () => [] }
        },
      }
    },
  }
}

describe("reconcileCaddyRoutes", () => {
  test("upserts une route par app prête", async () => {
    const { caddy, calls } = createFakeCaddy()
    const apps: AppForReconcile[] = [
      app({ id: "a1", container_id: "ploydok-app-a1-blue" }),
      app({
        id: "a2",
        container_id: "ploydok-app-a2-green",
        healthcheck_port: 8080,
      }),
    ]

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      apps,
    })

    expect(result).toEqual({
      bootstrapped: true,
      synced: 2,
      skipped: 0,
      failed: 0,
    })
    expect(calls.upserts).toEqual([
      {
        appId: "a1",
        host: "a1.test.local",
        upstream: { host: "ploydok-app-a1-blue", port: 3000 },
      },
      {
        appId: "a2",
        host: "a2.test.local",
        upstream: { host: "ploydok-app-a2-green", port: 8080 },
      },
    ])
  })

  test("uses runtime_port for Caddy upstream even when healthcheck_port differs", async () => {
    const { caddy, calls } = createFakeCaddy()
    const apps: AppForReconcile[] = [
      app({
        id: "laravel",
        container_id: "ploydok-app-laravel-blue",
        runtime_port: 80,
        healthcheck_port: 3000,
      }),
    ]

    await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      apps,
    })

    expect(calls.upserts[0]?.upstream).toEqual({
      host: "ploydok-app-laravel-blue",
      port: 80,
    })
  })

  test("fallback port par défaut si healthcheck_port absent", async () => {
    const { caddy, calls } = createFakeCaddy()
    const apps: AppForReconcile[] = [
      app({
        id: "a1",
        container_id: "ploydok-app-a1-blue",
        runtime_port: null,
        healthcheck_port: null,
      }),
    ]

    await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      apps,
      defaultPort: 4242,
    })

    expect(calls.upserts[0]?.upstream.port).toBe(4242)
  })

  test("skip les apps sans domain ou container_id", async () => {
    const { caddy, calls } = createFakeCaddy()
    const apps: AppForReconcile[] = [
      app({ id: "a1", domain: null, container_id: "ploydok-app-a1-blue" }),
      app({ id: "a2", container_id: null }),
      app({ id: "a3", container_id: "ploydok-app-a3-blue" }),
    ]

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      apps,
    })

    expect(result.synced).toBe(1)
    expect(result.skipped).toBe(2)
    expect(calls.upserts).toHaveLength(1)
    expect(calls.upserts[0]?.appId).toBe("a3")
  })

  test("upsert une route file_server pour les apps static sans container", async () => {
    const { caddy, calls } = createFakeCaddy()
    const apps: AppForReconcile[] = [
      app({
        id: "static1",
        container_id: null,
        build_method: "static",
        static_spa_fallback: true,
      }),
    ]

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      apps,
    })

    expect(result.synced).toBe(1)
    expect(calls.upserts).toHaveLength(0)
    expect(calls.staticUpserts[0]).toMatchObject({
      appId: "static1",
      host: "static1.test.local",
      root: "/var/lib/ploydok/static/static1/current",
      spaFallback: true,
    })
  })

  test("propage la config CDN aux apps static reconciliees", async () => {
    const { caddy, calls } = createFakeCaddy()
    const apps: AppForReconcile[] = [
      app({
        id: "static-cdn",
        container_id: null,
        build_method: "static",
        static_spa_fallback: false,
        cdn_mode: "internal",
        cdn_cache_ttl_s: 600,
        cdn_cache_paths: ["/assets/*"],
        cdn_compression: true,
        cdn_image_optim: true,
        cdn_headers: '{"Cache-Control":"public, max-age=600"}',
      }),
    ]

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      apps,
    })

    expect(result).toEqual({
      bootstrapped: true,
      synced: 1,
      skipped: 0,
      failed: 0,
    })
    expect(calls.staticUpserts[0]).toMatchObject({
      appId: "static-cdn",
      host: "static-cdn.test.local",
      root: "/var/lib/ploydok/static/static-cdn/current",
      spaFallback: false,
      cdn: {
        cdn_mode: "internal",
        cdn_cache_ttl_s: 600,
        cdn_cache_paths: ["/assets/*"],
        cdn_compression: true,
        cdn_image_optim: true,
        cdn_headers: '{"Cache-Control":"public, max-age=600"}',
      },
    })
  })

  test("une erreur Caddy par app n'arrête pas la boucle", async () => {
    const { caddy, calls } = createFakeCaddy({
      upsertErrorFor: new Set(["a1"]),
    })
    const apps: AppForReconcile[] = [
      app({ id: "a1", container_id: "ploydok-app-a1-blue" }),
      app({ id: "a2", container_id: "ploydok-app-a2-blue" }),
    ]

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      apps,
    })

    expect(result).toEqual({
      bootstrapped: true,
      synced: 1,
      skipped: 0,
      failed: 1,
    })
    expect(calls.upserts.map((c) => c.appId)).toEqual(["a2"])
  })

  test("retry bootstrap avec backoff (2 erreurs puis succès)", async () => {
    const { caddy, calls } = createFakeCaddy({ bootstrapErrors: 2 })
    const apps: AppForReconcile[] = [
      app({ id: "a1", container_id: "ploydok-app-a1-blue" }),
    ]

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      apps,
      bootstrapRetries: 3,
      bootstrapBackoffMs: 1,
    })

    expect(calls.bootstrap).toBe(3)
    expect(result.bootstrapped).toBe(true)
    expect(result.synced).toBe(1)
  })

  test("bootstrap échoue après N retries — skip la boucle sans throw", async () => {
    const { caddy, calls } = createFakeCaddy({ bootstrapErrors: 5 })
    const apps: AppForReconcile[] = [
      app({ id: "a1", container_id: "ploydok-app-a1-blue" }),
    ]

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      apps,
      bootstrapRetries: 2,
      bootstrapBackoffMs: 1,
    })

    expect(result).toEqual({
      bootstrapped: false,
      synced: 0,
      skipped: 0,
      failed: 0,
    })
    expect(calls.upserts).toHaveLength(0)
  })

  test("cleans a retained owned slot only after the new route is applied", async () => {
    const routeCalls: Array<{ host: string; upstream: { host: string; port: number } }> = []
    const stopped: string[] = []
    const removed: string[] = []
    const caddy = {
      async ensureBootstrap() {},
      async getUpstream() {
        return { host: "ploydok-app-demo-a1-blue", port: 3000 }
      },
      async setUpstream(
        _appId: string,
        host: string,
        upstream: { host: string; port: number }
      ) {
        routeCalls.push({ host, upstream })
      },
      async upsertStaticRoute() {},
    } as unknown as CaddyClient
    const agent = {
      async inspectContainerHealth() {
        return {
          status: 1,
          running: true,
          state: "running",
          containerMissing: false,
        }
      },
      async listContainers() {
        return {
          containers: [
            {
              id: "container-blue",
              name: "ploydok-app-demo-a1-blue",
              appId: "a1",
            },
          ],
        }
      },
      async containerStop(request: { containerId: string }) {
        stopped.push(request.containerId)
      },
      async containerRemove(request: { containerId: string }) {
        removed.push(request.containerId)
      },
    }
    const db = {
      select() {
        const query = {
          from() {
            return query
          },
          where() {
            return {
              limit: async () => [],
              orderBy() {
                return { limit: async () => [] }
              },
            }
          },
        }
        return query
      },
      update() {
        return {
          set() {
            return { where: async () => [] }
          },
        }
      },
    }

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      db: db as never,
      agent: agent as never,
      apps: [
        app({
          id: "a1",
          domain: "a1.demo.localhost",
          container_id: "ploydok-app-demo-a1-green",
          slug: "demo",
          domain_source: "generated",
          routing_status: "ready",
          routing_dns_status: "unknown",
        }),
      ],
    })

    expect(result).toEqual({
      bootstrapped: true,
      synced: 1,
      skipped: 0,
      failed: 0,
    })
    expect(routeCalls).toEqual([
      {
        host: "a1.demo.localhost",
        upstream: { host: "ploydok-app-demo-a1-green", port: 3000 },
      },
    ])
    expect(stopped).toEqual(["container-blue"])
    expect(removed).toEqual(["container-blue"])
  })

  test("skips an app while its deployment lease is active", async () => {
    let routeCalls = 0
    const caddy = {
      async ensureBootstrap() {},
      async setUpstream() {
        routeCalls++
      },
      async getUpstream() {
        routeCalls++
        return null
      },
    } as unknown as CaddyClient

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      db: makeReconcileDb(true) as never,
      enableDeployLease: true,
      apps: [
        app({
          id: "a1",
          domain: "a1.demo.localhost",
          container_id: "ploydok-app-demo-a1-green",
          domain_source: "generated",
          routing_status: "ready",
          routing_dns_status: "unknown",
        }),
      ],
    })

    expect(result).toEqual({
      bootstrapped: true,
      synced: 0,
      skipped: 1,
      failed: 0,
    })
    expect(routeCalls).toBe(0)
  })

  test("accepts a legacy Compose runtime without a healthcheck when it is running", async () => {
    const routeCalls: Array<{ host: string; upstream: { host: string; port: number } }> = []
    const caddy = {
      async ensureBootstrap() {},
      async getUpstream() {
        return null
      },
      async getRouteHost() {
        return null
      },
      async setUpstream(
        _appId: string,
        host: string,
        upstream: { host: string; port: number }
      ) {
        routeCalls.push({ host, upstream })
      },
    } as unknown as CaddyClient
    const agent = {
      async inspectContainerHealth() {
        return {
          status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_NONE,
          running: true,
          state: "running",
          containerMissing: false,
        }
      },
      async listContainers() {
        return { containers: [] }
      },
    }

    const result = await reconcileCaddyRoutes({
      caddy,
      logger: silentLogger,
      db: makeReconcileDb() as never,
      agent: agent as never,
      apps: [
        app({
          id: "a1",
          domain: "a1.demo.localhost",
          container_id: "ploydok-app-demo-a1-blue",
          runtime_mode: "docker",
          build_method: "compose",
          runtime_has_healthcheck: null,
          healthcheck_port: null,
          domain_source: "generated",
          routing_status: "ready",
          routing_dns_status: "unknown",
        }),
      ],
    })

    expect(result).toEqual({
      bootstrapped: true,
      synced: 1,
      skipped: 0,
      failed: 0,
    })
    expect(routeCalls).toEqual([
      {
        host: "a1.demo.localhost",
        upstream: { host: "ploydok-app-demo-a1-blue", port: 3000 },
      },
    ])
  })

  test("retries retained slot cleanup after a transient agent failure", async () => {
    const routeCalls: Array<{ host: string; upstream: { host: string; port: number } }> = []
    const stopped: string[] = []
    const removed: string[] = []
    let stopFailures = 1
    const caddy = {
      async ensureBootstrap() {},
      async getUpstream() {
        return { host: "ploydok-app-demo-a1-blue", port: 3000 }
      },
      async getRouteHost() {
        return "a1.demo.localhost"
      },
      async setUpstream(
        _appId: string,
        host: string,
        upstream: { host: string; port: number }
      ) {
        routeCalls.push({ host, upstream })
      },
    } as unknown as CaddyClient
    const agent = {
      async inspectContainerHealth() {
        return {
          status: 1,
          running: true,
          state: "running",
          containerMissing: false,
        }
      },
      async listContainers() {
        return {
          containers: [
            {
              id: "container-blue",
              name: "ploydok-app-demo-a1-blue",
              appId: "a1",
            },
          ],
        }
      },
      async containerStop(request: { containerId: string }) {
        stopped.push(request.containerId)
        if (stopFailures > 0) {
          stopFailures--
          throw new Error("temporary agent outage")
        }
      },
      async containerRemove(request: { containerId: string }) {
        removed.push(request.containerId)
      },
    }
    const options = {
      caddy,
      logger: silentLogger,
      db: makeReconcileDb() as never,
      agent: agent as never,
      apps: [
        app({
          id: "a1",
          domain: "a1.demo.localhost",
          container_id: "ploydok-app-demo-a1-green",
          slug: "demo",
          domain_source: "generated",
          routing_status: "ready",
          routing_dns_status: "unknown",
        }),
      ],
    }

    const first = await reconcileCaddyRoutes(options)
    const second = await reconcileCaddyRoutes(options)

    expect(first).toMatchObject({ synced: 0, skipped: 0, failed: 1 })
    expect(second).toMatchObject({ synced: 1, skipped: 0, failed: 0 })
    expect(routeCalls).toHaveLength(2)
    expect(stopped).toEqual(["container-blue", "container-blue"])
    expect(removed).toEqual(["container-blue", "container-blue"])
  })
})

describe("reconcileServiceRoutes", () => {
  test("utilise le nom Swarm persiste avec le port Compose", async () => {
    const { caddy, upserts } = createFakeServiceCaddy()
    const services: ServiceForReconcile[] = [
      {
        id: "svc-1",
        slug: "demo",
        domain: "demo.example.com",
        compose_raw: `
services:
  web:
    image: nginx:alpine
    expose: [80]
    environment:
      TOKEN: __PLOYDOK_SECRET_0__
`,
        container_ids: [],
        swarm_service_names: ["ploydok-app-svc-svc-1-demo-web"],
        runtime_mode: "swarm",
      },
    ]

    const result = await reconcileServiceRoutes({
      caddy,
      logger: silentLogger,
      services,
    })

    expect(result).toEqual({
      bootstrapped: true,
      synced: 1,
      skipped: 0,
      failed: 0,
    })
    expect(upserts).toEqual([
      {
        accessLogs: false,
        host: "demo.example.com",
        upstream: "ploydok-app-svc-svc-1-demo-web:80",
        appId: "svc-1",
      },
    ])
  })

  test("utilise le nom du conteneur Docker persiste avec le port Compose", async () => {
    const { caddy, upserts } = createFakeServiceCaddy()
    const services: ServiceForReconcile[] = [
      {
        id: "svc-docker",
        slug: "demo",
        domain: "docker.example.com",
        compose_raw: `
services:
  web:
    image: nginx:alpine
    ports: ["127.0.0.1:8080:80"]
`,
        container_ids: ["ctr-1"],
        swarm_service_names: [],
        runtime_mode: "docker",
      },
    ]

    await reconcileServiceRoutes({
      caddy,
      logger: silentLogger,
      services,
    })

    expect(upserts).toEqual([
      {
        accessLogs: false,
        host: "docker.example.com",
        upstream: "ploydok-svc-svc-docker-web:80",
        appId: "svc-docker",
      },
    ])
  })

  test.each(["docker", "swarm"] as const)("uses the declared entrypoint for a %s service route", async (runtime) => {
    const { caddy, upserts } = createFakeServiceCaddy()
    await reconcileServiceRoutes({
      caddy,
      logger: silentLogger,
      services: [
        {
          id: "svc-declared",
          slug: "demo",
          domain: "declared.example.com",
          compose_raw: `
services:
  worker:
    image: alpine
    expose: [9000]
  web:
    image: nginx:alpine
    ports: ["__PLOYDOK_SECRET_0__:8080"]
`,
          container_ids: runtime === "docker" ? ["ctr-worker", "ctr-web"] : [],
          swarm_service_names: runtime === "swarm" ? ["ploydok-app-svc-svc-declared-demo-worker", "ploydok-app-svc-svc-declared-demo-web"] : [],
          runtime_mode: runtime,
          entrypoint_service_name: "web",
          entrypoint_port: 8088,
        },
      ],
    })

    expect(upserts).toEqual([
      {
        accessLogs: false,
        host: "declared.example.com",
        upstream: runtime === "swarm" ? "ploydok-app-svc-svc-declared-demo-web:8088" : "ploydok-svc-svc-declared-web:8088",
        appId: "svc-declared",
      },
    ])
  })

  test("reconstructs the sanitized Docker entrypoint for a raw Nano ID", async () => {
    const { caddy, upserts } = createFakeServiceCaddy()
    await reconcileServiceRoutes({
      caddy,
      logger: silentLogger,
      services: [{
        id: "vAabMU_x0H0WQxlqV9J1-",
        slug: "demo",
        domain: "declared.example.com",
        compose_raw: "services: {}",
        container_ids: ["ctr-web"],
        swarm_service_names: [],
        runtime_mode: "docker",
        entrypoint_service_name: "Web_App",
        entrypoint_port: 8088,
      }],
    })
    expect(upserts[0]?.upstream).toBe(
      "ploydok-svc-vaabmu-x0h0wqxlqv9j1-web-app-0399d8a8b2:8088"
    )
  })

  test("uses persisted service routing data without re-rendering an installed template", async () => {
    const { caddy, upserts } = createFakeServiceCaddy()
    const result = await reconcileServiceRoutes({
      caddy,
      logger: silentLogger,
      services: [
        {
          id: "svc-installed",
          slug: "n8n",
          domain: "http://n8n.apps.example.test:8181",
          // The worker already persisted the declared route target. The
          // encrypted or legacy Compose payload is not needed for routing.
          compose_raw: "this is no longer a renderable template",
          container_ids: ["ctr-n8n"],
          swarm_service_names: [],
          runtime_mode: "docker",
          entrypoint_service_name: "n8n",
          entrypoint_port: 5678,
        },
      ],
    })

    expect(result).toEqual({
      bootstrapped: true,
      synced: 1,
      skipped: 0,
      failed: 0,
    })
    expect(upserts).toEqual([
      {
        accessLogs: false,
        host: "n8n.apps.example.test",
        upstream: "ploydok-svc-svc-installed-n8n:5678",
        appId: "svc-installed",
      },
    ])
  })
})
