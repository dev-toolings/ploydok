// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import pino from "pino"
import {
  reconcileCaddyRoutes,
  reconcileServiceRoutes,
  type AppForReconcile,
  type ServiceForReconcile,
} from "./reconciler.js"
import type { CaddyClient } from "./client.js"

const silentLogger = pino({ level: "silent" })

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
    id: overrides.id,
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
  upserts: Array<{ host: string; upstream: string; appId: string }>
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
        host: "demo.example.com",
        upstream: "ploydok-app-svc-svc-1-demo-web:80",
        appId: "svc-1",
      },
    ])
  })
})
