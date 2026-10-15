// SPDX-License-Identifier: AGPL-3.0-only
//
// Au boot de l'API, Caddy peut avoir été redémarré en parallèle (docker compose
// up, crash, reboot host) et perdu son état mémoire. La DB reste la source de
// vérité pour les routes applicatives : on re-pousse toutes les routes des
// apps `running`/`restarting` vers l'Admin API Caddy. Idempotent via
// `setUpstream` (PATCH si route existe, POST sinon).
import { swarmComposeServiceName } from "../worker/compose-swarm.js"
import { and, eq, inArray, isNotNull } from "drizzle-orm"
import {
  apps as appsTable,
  databases as databasesTable,
  services as servicesTable,
  type Db,
} from "@ploydok/db"
import type { CaddyClient } from "./client.js"
import type { Logger } from "pino"
import { caddyStaticRootForApp } from "../worker/handlers/build-static.js"
import { composeToContainers } from "../marketplace/compose-to-containers.js"
import { upsertServiceRoute } from "./service-routes.js"
export { applyCdnHandlers, type CdnAppConfig } from "./cdn.js"

export interface AppForReconcile {
  id: string
  domain: string | null
  container_id: string | null
  runtime_mode: "docker" | "swarm"
  swarm_service_name: string | null
  runtime_port: number | null
  healthcheck_port: number | null
  build_method: string | null
  static_spa_fallback: boolean | null
  cdn_mode: "off" | "internal" | "external"
  cdn_cache_ttl_s: number | null
  cdn_cache_paths: string[] | null
  cdn_compression: boolean | null
  cdn_image_optim: boolean | null
  cdn_headers: string | null
  cdn_external_provider: string | null
}

export interface ReconcileResult {
  bootstrapped: boolean
  synced: number
  skipped: number
  failed: number
}

export interface ServiceForReconcile {
  id: string
  slug: string
  domain: string | null
  compose_raw: string
  container_ids: string[] | null
  swarm_service_names: string[] | null
  runtime_mode?: "docker" | "swarm" | null
  entrypoint_service_name?: string | null
  entrypoint_port?: number | null
}

export interface DatabaseProxyForReconcile {
  id: string
  host: string | null
  port: number | null
  public_port: number | null
}

/** Reconciliation may restore a verified route, but cannot authorize a new custom host. */
export function canRestoreAppRoute(app: {
  domain_source: string
  routing_status: string
  routing_dns_status: string | null
}): boolean {
  return app.domain_source === "generated" || app.routing_status === "ready" ||
    app.routing_dns_status === "valid"
}

export async function fetchRunningAppsForCaddy(
  db: Db
): Promise<AppForReconcile[]> {
  const rows = await db
    .select({
      id: appsTable.id,
      domain_source: appsTable.domain_source,
      routing_status: appsTable.routing_status,
      routing_dns_status: appsTable.routing_dns_status,
      domain: appsTable.domain,
      container_id: appsTable.container_id,
      runtime_mode: appsTable.runtime_mode,
      swarm_service_name: appsTable.swarm_service_name,
      runtime_port: appsTable.runtime_port,
      healthcheck_port: appsTable.healthcheck_port,
      build_method: appsTable.build_method,
      static_spa_fallback: appsTable.static_spa_fallback,
      cdn_mode: appsTable.cdn_mode,
      cdn_cache_ttl_s: appsTable.cdn_cache_ttl_s,
      cdn_cache_paths: appsTable.cdn_cache_paths,
      cdn_compression: appsTable.cdn_compression,
      cdn_image_optim: appsTable.cdn_image_optim,
      cdn_headers: appsTable.cdn_headers,
      cdn_external_provider: appsTable.cdn_external_provider,
    })
    .from(appsTable)
    .where(
      and(
        inArray(appsTable.status, ["running", "restarting", "serving"]),
        isNotNull(appsTable.domain)
      )
    )
  return rows.filter(canRestoreAppRoute)
}

export async function fetchRunningServicesForCaddy(
  db: Db
): Promise<ServiceForReconcile[]> {
  return db
    .select({
      id: servicesTable.id,
      slug: servicesTable.slug,
      domain: servicesTable.domain,
      compose_raw: servicesTable.compose_raw,
      container_ids: servicesTable.container_ids,
      swarm_service_names: servicesTable.swarm_service_names,
      runtime_mode: servicesTable.runtime_mode,
      entrypoint_service_name: servicesTable.entrypoint_service_name,
      entrypoint_port: servicesTable.entrypoint_port,
    })
    .from(servicesTable)
    .where(and(eq(servicesTable.status, "running"), isNotNull(servicesTable.domain)))
}

export async function fetchPublicDatabaseProxiesForCaddy(
  db: Db
): Promise<DatabaseProxyForReconcile[]> {
  return db
    .select({
      id: databasesTable.id,
      host: databasesTable.host,
      port: databasesTable.port,
      public_port: databasesTable.public_port,
    })
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.status, "running"),
        eq(databasesTable.public_enabled, true),
        eq(databasesTable.exposure_mode, "public_proxy"),
        isNotNull(databasesTable.public_port)
      )
    )
}

export interface ReconcileOptions {
  caddy: CaddyClient
  logger: Logger
  apps: AppForReconcile[]
  defaultPort?: number
  bootstrapRetries?: number
  bootstrapBackoffMs?: number
}

function normalizeDatabaseRuntimeToken(dbId: string, maxLength: number): string {
  const normalized = dbId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)

  return normalized || "db"
}

function databaseTcpProxyServerId(dbId: string): string {
  return `ploydok-db-proxy-${normalizeDatabaseRuntimeToken(dbId, 54)}`
}

export async function reconcileServiceRoutes(opts: {
  caddy: CaddyClient
  logger: Logger
  services: ServiceForReconcile[]
}): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    bootstrapped: false,
    synced: 0,
    skipped: 0,
    failed: 0,
  }

  const bootstrapped = await tryBootstrap(opts.caddy, opts.logger, 3, 500)
  result.bootstrapped = bootstrapped
  if (!bootstrapped) return result

  for (const service of opts.services) {
    if (!service.domain) {
      result.skipped++
      continue
    }
    try {
      const swarmServiceNames = service.swarm_service_names ?? []
      const containerIds = service.container_ids ?? []
      if (swarmServiceNames.length === 0 && containerIds.length === 0) {
        result.skipped++
        continue
      }

      const runtimeMode =
        service.runtime_mode ??
        (swarmServiceNames.length > 0 ? "swarm" : "docker")
      // The declared route is sufficient without parsing encrypted Compose
      // scalars (a generated port may itself have been vaulted).
      if (service.entrypoint_service_name != null && service.entrypoint_port != null) {
        const name = runtimeMode === "swarm"
          ? swarmComposeServiceName(`svc-${service.id}-${service.slug}`.slice(0, 40), service.entrypoint_service_name)
          : `ploydok-svc-${service.id}-${service.entrypoint_service_name}`
        if (runtimeMode === "swarm" && !swarmServiceNames.includes(name)) {
          throw new Error(`Service ${service.id} declared entrypoint is not running`)
        }
        await upsertServiceRoute(opts.caddy, {
          serviceId: service.id, domain: service.domain, containers: [],
          entrypoint: { name, port: service.entrypoint_port },
        })
        result.synced++
        continue
      }
      const containers = composeToContainers({
        compose: service.compose_raw,
        runtime: runtimeMode,
        servicePrefix: `ploydok-svc-${service.id}`,
        network: "ploydok-service-route",
        labels: {
          "ploydok.kind": "service",
          "ploydok.service_id": service.id,
        },
      })
      const routeContainers =
        swarmServiceNames.length === 0
          ? containers
          : (() => {
              if (swarmServiceNames.length !== containers.length) {
                throw new Error(
                  `Service ${service.id} has ${swarmServiceNames.length} Swarm service names for ${containers.length} Compose services`
                )
              }
              return containers.map((container, index) => ({
                ...container,
                name: swarmServiceNames[index]!,
              }))
            })()
      await upsertServiceRoute(opts.caddy, {
        serviceId: service.id,
        domain: service.domain,
        containers: routeContainers,
      })
      result.synced++
      opts.logger.info(
        { serviceId: service.id, host: service.domain },
        "caddy service route reconciled"
      )
    } catch (err) {
      result.failed++
      opts.logger.warn(
        { err, serviceId: service.id, host: service.domain },
        "caddy service route reconcile failed"
      )
    }
  }

  opts.logger.info(result, "caddy service route reconcile done")
  return result
}

export async function reconcileDatabaseTcpProxies(opts: {
  caddy: CaddyClient
  logger: Logger
  databases: DatabaseProxyForReconcile[]
}): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    bootstrapped: false,
    synced: 0,
    skipped: 0,
    failed: 0,
  }

  try {
    await opts.caddy.ensureLayer4Bootstrap()
    result.bootstrapped = true
  } catch (err) {
    opts.logger.warn({ err }, "caddy layer4 bootstrap failed")
    return result
  }

  for (const database of opts.databases) {
    if (!database.host || !database.port || !database.public_port) {
      result.skipped++
      continue
    }
    try {
      await opts.caddy.upsertTcpProxy({
        serverId: databaseTcpProxyServerId(database.id),
        listenPort: database.public_port,
        upstream: `${database.host}:${database.port}`,
      })
      result.synced++
      opts.logger.info(
        { databaseId: database.id, publicPort: database.public_port },
        "caddy database tcp proxy reconciled"
      )
    } catch (err) {
      result.failed++
      opts.logger.warn(
        { err, databaseId: database.id, publicPort: database.public_port },
        "caddy database tcp proxy reconcile failed"
      )
    }
  }

  opts.logger.info(result, "caddy database tcp proxy reconcile done")
  return result
}

export async function reconcileCaddyRoutes(
  opts: ReconcileOptions
): Promise<ReconcileResult> {
  const {
    caddy,
    logger,
    apps,
    defaultPort = 3000,
    bootstrapRetries = 3,
    bootstrapBackoffMs = 500,
  } = opts

  const result: ReconcileResult = {
    bootstrapped: false,
    synced: 0,
    skipped: 0,
    failed: 0,
  }

  const bootstrapped = await tryBootstrap(
    caddy,
    logger,
    bootstrapRetries,
    bootstrapBackoffMs
  )
  result.bootstrapped = bootstrapped
  if (!bootstrapped) return result

  for (const row of apps) {
    if (!row.domain) {
      result.skipped++
      continue
    }
    try {
      if (row.build_method === "static") {
        await caddy.upsertStaticRoute({
          appId: row.id,
          host: row.domain,
          root: caddyStaticRootForApp(row.id),
          spaFallback: row.static_spa_fallback ?? true,
          cdn: row,
        })
      } else {
        const upstreamHost =
          row.runtime_mode === "swarm" ? row.swarm_service_name : row.container_id
        if (!upstreamHost) {
          result.skipped++
          continue
        }
        const port = row.runtime_port ?? row.healthcheck_port ?? defaultPort
        await caddy.setUpstream(
          row.id,
          row.domain,
          { host: upstreamHost, port },
          { cdn: row }
        )
      }
      result.synced++
      logger.info({ appId: row.id, host: row.domain }, "caddy route reconciled")
    } catch (err) {
      result.failed++
      logger.warn(
        { err, appId: row.id, host: row.domain },
        "caddy route reconcile failed"
      )
    }
  }

  logger.info(result, "caddy reconcile done")
  return result
}

async function tryBootstrap(
  caddy: CaddyClient,
  logger: Logger,
  retries: number,
  backoffMs: number
): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await caddy.ensureBootstrap()
      return true
    } catch (err) {
      if (attempt === retries) {
        logger.warn(
          { err, attempts: attempt },
          "caddy bootstrap failed — reconcile skipped"
        )
        return false
      }
      await new Promise((r) => setTimeout(r, backoffMs * attempt))
    }
  }
  return false
}
