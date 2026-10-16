// SPDX-License-Identifier: AGPL-3.0-only
//
// Au boot de l'API, Caddy peut avoir été redémarré en parallèle (docker compose
// up, crash, reboot host) et perdu son état mémoire. La DB reste la source de
// vérité pour les routes applicatives : on re-pousse toutes les routes des
// apps `running`/`restarting` vers l'Admin API Caddy. Idempotent via
// `setUpstream` (PATCH si route existe, POST sinon).
import { swarmComposeServiceName } from "../worker/compose-swarm.js"
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  notExists,
} from "drizzle-orm"
import {
  app_deploy_leases,
  apps as appsTable,
  builds,
  databases as databasesTable,
  services as servicesTable,
  type Db,
} from "@ploydok/db"
import type { CaddyClient } from "./client.js"
import type { Logger } from "pino"
import { caddyStaticRootForApp } from "../worker/handlers/build-static.js"
import { composeToContainers } from "../marketplace/compose-to-containers.js"
import { upsertServiceRoute } from "./service-routes.js"
import { runningBuildMatch } from "../services/runtime-build.js"
import { ContainerHealthStatus } from "@ploydok/agent-proto"
import type { Agent } from "../agent/index.js"
import { isNotFound, toAgentError } from "../agent/errors.js"
import { listSwarmTasks, taskIsHealthy } from "../worker/swarm-runner.js"
import {
  publishHealthyAppRoute,
  syncAppDomainAliases,
} from "../domains/routing.js"
import {
  runtimeContainerNameCandidates,
  type RuntimeContainerColor,
} from "../services/runtime-containers.js"
import {
  DeployLeaseLostError,
  fenceDeploySideEffect,
  withAppDeployLease,
} from "../worker/app-deploy-lock.js"
export { applyCdnHandlers, type CdnAppConfig } from "./cdn.js"

export interface AppForReconcile {
  id: string
  slug?: string
  domain_source?: string
  routing_status?: string
  routing_dns_status?: string | null
  current_build_id?: string | null
  updated_at?: Date | null
  domain: string | null
  container_id: string | null
  runtime_mode: "docker" | "swarm"
  swarm_service_name: string | null
  replicas?: number | null
  runtime_port: number | null
  healthcheck_port: number | null
  healthcheck_path?: string | null
  healthcheck_interval_s?: number | null
  healthcheck_timeout_s?: number | null
  healthcheck_retries?: number | null
  healthcheck_start_period_s?: number | null
  runtime_has_healthcheck?: boolean | null
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
  return (
    app.domain_source === "generated" ||
    app.routing_status === "ready" ||
    app.routing_dns_status === "valid"
  )
}

export async function fetchRunningAppsForCaddy(
  db: Db
): Promise<AppForReconcile[]> {
  const rows = await db
    .select({
      id: appsTable.id,
      slug: appsTable.slug,
      domain_source: appsTable.domain_source,
      routing_status: appsTable.routing_status,
      routing_dns_status: appsTable.routing_dns_status,
      domain: appsTable.domain,
      container_id: appsTable.container_id,
      runtime_mode: appsTable.runtime_mode,
      swarm_service_name: appsTable.swarm_service_name,
      updated_at: appsTable.updated_at,
      replicas: appsTable.replicas,
      runtime_port: appsTable.runtime_port,
      healthcheck_port: appsTable.healthcheck_port,
      healthcheck_path: appsTable.healthcheck_path,
      healthcheck_interval_s: appsTable.healthcheck_interval_s,
      healthcheck_timeout_s: appsTable.healthcheck_timeout_s,
      healthcheck_retries: appsTable.healthcheck_retries,
      healthcheck_start_period_s: appsTable.healthcheck_start_period_s,
      runtime_has_healthcheck: appsTable.runtime_has_healthcheck,
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
        isNotNull(appsTable.domain),
        notExists(
          db
            .select({ app_id: app_deploy_leases.app_id })
            .from(app_deploy_leases)
            .where(
              and(
                eq(app_deploy_leases.app_id, appsTable.id),
                gt(app_deploy_leases.lease_until, new Date())
              )
            )
        )
      )
    )
  return Promise.all(
    rows.map(async (row) => {
      const buildFilter = and(
        eq(builds.app_id, row.id),
        inArray(builds.status, ["succeeded", "succeeded_with_warning"]),
        runningBuildMatch(row)
      )
      const buildRows = await db
        .select({ id: builds.id })
        .from(builds)
        .where(buildFilter)
        .orderBy(desc(builds.created_at), desc(builds.id))
        .limit(1)
      return { ...row, current_build_id: buildRows[0]?.id ?? null }
    })
  )
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
  /** Production reconciliation needs the DB to reuse the domain proof gate. */
  db?: Db
  /** Production reconciliation needs the agent to health-gate a new runtime. */
  agent?: Agent
  /** Production ingress passes this to serialize route changes with deploys. */
  enableDeployLease?: boolean
  defaultPort?: number
  bootstrapRetries?: number
  bootstrapBackoffMs?: number
}

function runtimeSlotNames(
  row: AppForReconcile,
  color: RuntimeContainerColor
): Set<string> {
  if (!row.slug) return new Set()
  return new Set(
    runtimeContainerNameCandidates({ id: row.id, slug: row.slug }, color)
  )
}

function isOwnedRuntimeSlot(row: AppForReconcile, host: string): boolean {
  return (
    runtimeSlotNames(row, "blue").has(host) ||
    runtimeSlotNames(row, "green").has(host)
  )
}

function appHasConfiguredHealthcheck(row: AppForReconcile): boolean {
  if (row.runtime_has_healthcheck === undefined) return false
  if (row.runtime_has_healthcheck !== null) return row.runtime_has_healthcheck
  if (row.build_method !== "compose") return true
  return [
    row.healthcheck_path,
    row.healthcheck_port,
    row.healthcheck_interval_s,
    row.healthcheck_timeout_s,
    row.healthcheck_retries,
    row.healthcheck_start_period_s,
  ].some((value) => value !== null && value !== undefined)
}

async function healthGateDockerRuntime(
  agent: Agent,
  db: Db | undefined,
  row: AppForReconcile,
  targetHost: string
): Promise<void> {
  if (row.build_method === "static") return
  if (row.runtime_mode === "swarm") {
    if (!db) return
    const tasks = await listSwarmTasks(row.id, db)
    const healthy = tasks.filter((task) =>
      taskIsHealthy(task, appHasConfiguredHealthcheck(row))
    )
    if (healthy.length < Math.max(1, row.replicas ?? 1)) {
      throw new Error(`Runtime ${targetHost} is not healthy`)
    }
    return
  }

  const health = await agent.inspectContainerHealth({ containerId: targetHost })
  const running = health.running === true || health.state === "running"
  const ready =
    health.status === ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY ||
    (health.status === ContainerHealthStatus.CONTAINER_HEALTH_STATUS_NONE &&
      !appHasConfiguredHealthcheck(row))
  if (health.containerMissing || !running || !ready) {
    throw new Error(`Runtime ${targetHost} is not healthy`)
  }
}

async function cleanupReplacedRuntimeSlot(opts: {
  agent: Agent
  logger: Logger
  row: AppForReconcile
  previousUpstream: { host: string; port: number } | null
  currentUpstream: { host: string; port: number }
}): Promise<boolean> {
  const { agent, logger, row, previousUpstream, currentUpstream } = opts
  // A deterministic slot name is necessary but not sufficient ownership
  // proof. Verify the agent label before removing anything from Docker.
  const listed = await agent.listContainers({ kindFilter: "app" })
  const ownedNames = new Set([
    ...runtimeSlotNames(row, "blue"),
    ...runtimeSlotNames(row, "green"),
  ])
  const retained = listed.containers.filter(
    (container) =>
      container.appId === row.id &&
      ownedNames.has(container.name) &&
      container.name !== currentUpstream.host
  )
  if (retained.length === 0) {
    if (previousUpstream && isOwnedRuntimeSlot(row, previousUpstream.host)) {
      logger.debug(
        { appId: row.id, host: previousUpstream.host },
        "caddy reconcile: retained runtime is already gone"
      )
    }
    return true
  }

  let ok = true
  for (const previous of retained) {
    try {
      await fenceDeploySideEffect()
      await agent.containerStop({
        containerId: previous.id,
        timeoutSeconds: 10,
      })
    } catch (err) {
      if (isNotFound(toAgentError(err))) continue
      ok = false
      logger.warn(
        { err, appId: row.id, containerId: previous.id },
        "caddy reconcile: failed to stop retained runtime"
      )
    }
    try {
      await fenceDeploySideEffect()
      await agent.containerRemove({
        containerId: previous.id,
        force: true,
        removeVolumes: false,
      })
    } catch (err) {
      if (isNotFound(toAgentError(err))) continue
      ok = false
      logger.warn(
        { err, appId: row.id, containerId: previous.id },
        "caddy reconcile: failed to remove retained runtime"
      )
    }
  }
  return ok
}

async function hasActiveDeployLease(db: Db, appId: string): Promise<boolean> {
  const rows = await db
    .select({ app_id: app_deploy_leases.app_id })
    .from(app_deploy_leases)
    .where(
      and(
        eq(app_deploy_leases.app_id, appId),
        gt(app_deploy_leases.lease_until, new Date())
      )
    )
    .limit(1)
  return rows.length > 0
}

async function withReconcileDeployLease<T>(opts: {
  db: Db
  logger: Logger
  app: AppForReconcile
  enabled: boolean
  task: () => Promise<T>
}): Promise<T | null> {
  if (!opts.enabled) return opts.task()
  if (!opts.app.current_build_id) {
    // Without a build the route cannot be fenced, so it is never restored.
    // Say so: a silent skip leaves the app unreachable with no trace.
    opts.logger.warn(
      { appId: opts.app.id, containerId: opts.app.container_id },
      "caddy reconcile: no succeeded build matches the running runtime"
    )
    return null
  }
  try {
    return await withAppDeployLease(
      opts.db,
      opts.app.id,
      opts.app.current_build_id,
      opts.task
    )
  } catch (error) {
    if (error instanceof DeployLeaseLostError) return null
    throw error
  }
}

async function reconcileSnapshotIsCurrent(
  db: Db,
  row: AppForReconcile
): Promise<boolean> {
  const current = await db
    .select({
      container_id: appsTable.container_id,
      domain: appsTable.domain,
      status: appsTable.status,
      runtime_mode: appsTable.runtime_mode,
      swarm_service_name: appsTable.swarm_service_name,
      updated_at: appsTable.updated_at,
    })
    .from(appsTable)
    .where(eq(appsTable.id, row.id))
    .limit(1)
  const snapshot = current[0]
  return Boolean(
    snapshot &&
    snapshot.container_id === row.container_id &&
    snapshot.domain === row.domain &&
    ["running", "serving", "restarting"].includes(snapshot.status) &&
    snapshot.runtime_mode === row.runtime_mode &&
    snapshot.swarm_service_name === row.swarm_service_name &&
    snapshot.updated_at?.getTime() === row.updated_at?.getTime()
  )
}

function normalizeDatabaseRuntimeToken(
  dbId: string,
  maxLength: number
): string {
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
      if (opts.db && (await hasActiveDeployLease(opts.db, row.id))) {
        result.skipped++
        logger.debug(
          { appId: row.id },
          "caddy reconcile: deployment lease is active"
        )
        continue
      }
      const reconcileOne = async (): Promise<boolean> => {
        if (
          opts.db &&
          opts.enableDeployLease === true &&
          !(await reconcileSnapshotIsCurrent(opts.db, row))
        ) {
          return false
        }
        const isStatic = row.build_method === "static"
        const upstreamHost = isStatic
          ? null
          : row.runtime_mode === "swarm"
            ? row.swarm_service_name
            : row.container_id
        if (!isStatic && !upstreamHost) return false
        const port = row.runtime_port ?? row.healthcheck_port ?? defaultPort
        const upstream = upstreamHost ? { host: upstreamHost, port } : null

        // A Caddy read is part of the safety boundary: it identifies the
        // retained runtime that can be removed after the new route is proven.
        // If it fails, fail this app closed rather than overwrite an unknown
        // active route.
        const previousUpstream =
          opts.db && upstream ? await caddy.getUpstream(row.id) : null

        const applyRoute = async () => {
          if (isStatic) {
            await fenceDeploySideEffect()
            await caddy.upsertStaticRoute({
              appId: row.id,
              host: row.domain!,
              root: caddyStaticRootForApp(row.id),
              spaFallback: row.static_spa_fallback ?? true,
              cdn: row,
            })
            return
          }
          if (opts.agent && upstream) {
            await healthGateDockerRuntime(
              opts.agent,
              opts.db,
              row,
              upstream.host
            )
          }
          await fenceDeploySideEffect()
          await caddy.setUpstream(row.id, row.domain!, upstream!, { cdn: row })
        }

        let routeApplied = false
        if (opts.db) {
          const routeResult = await publishHealthyAppRoute({
            db: opts.db,
            appId: row.id,
            ...(row.current_build_id ? { buildId: row.current_build_id } : {}),
            hostname: row.domain!,
            getCurrentRouteHost: () => caddy.getRouteHost(row.id),
            proxied: row.cdn_mode === "external",
            beforePersist: fenceDeploySideEffect,
            applyRoute,
            afterRoute: async () => {
              const aliases = isStatic
                ? await syncAppDomainAliases({
                    db: opts.db!,
                    appId: row.id,
                    static: {
                      root: caddyStaticRootForApp(row.id),
                      spaFallback: row.static_spa_fallback ?? true,
                    },
                    caddy,
                    beforeSideEffect: fenceDeploySideEffect,
                  })
                : await syncAppDomainAliases({
                    db: opts.db!,
                    appId: row.id,
                    upstream: upstream!,
                    caddy,
                    beforeSideEffect: fenceDeploySideEffect,
                  })
              if (aliases.errors.length) {
                throw new Error("Alias routing requires attention")
              }
            },
          })
          routeApplied = routeResult.routeApplied
        } else {
          // Unit callers without a DB use the historical stored authorization
          // gate. Production always takes the proof-backed branch above.
          if (
            row.domain_source &&
            row.routing_status &&
            !canRestoreAppRoute({
              domain_source: row.domain_source,
              routing_status: row.routing_status,
              routing_dns_status: row.routing_dns_status ?? null,
            })
          ) {
            return false
          }
          await applyRoute()
          routeApplied = true
        }
        if (!routeApplied) return false

        if (opts.agent && upstream) {
          const cleaned = await cleanupReplacedRuntimeSlot({
            agent: opts.agent,
            logger,
            row,
            previousUpstream,
            currentUpstream: upstream,
          })
          if (!cleaned) {
            throw new Error("Retained runtime cleanup requires attention")
          }
        }
        return true
      }

      const reconciled = opts.db
        ? await withReconcileDeployLease({
            db: opts.db,
            logger,
            app: row,
            enabled: opts.enableDeployLease === true,
            task: reconcileOne,
          })
        : await reconcileOne()
      if (!reconciled) {
        result.skipped++
        continue
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
