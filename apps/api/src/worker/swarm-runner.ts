// SPDX-License-Identifier: AGPL-3.0-only
//
// Swarm runtime runner for app-level load balancing.

import * as grpc from "@grpc/grpc-js"
import { and, desc, eq, inArray } from "drizzle-orm"
import { AgentClient } from "@ploydok/agent-proto"
import type {
  ListServiceTasksResponse,
  ServiceCreateResponse,
  ServiceRollbackResponse,
  ServiceUpdateImageResponse,
  SwarmEnsureSingleNodeResponse,
  SwarmServiceSpec,
  SwarmTaskSnapshot,
} from "@ploydok/agent-proto"
import { apps, builds, projects } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { createAgentClient } from "../agent/client.js"
import { toAgentError } from "../agent/errors.js"
import { CaddyClient } from "../caddy/client.js"
import { publishHealthyAppRoute, syncAppDomainAliases } from "../domains/routing.js"
import { assertDomainAvailable, withDomainLock } from "../domains/availability.js"
import { ensureCaddyOnProjectNetwork } from "../caddy/attachment.js"
import { getSharedAgent } from "../debug/singletons.js"
import { listRuntimeAppVolumeMounts } from "../services/app-volumes.js"
import {
  ensureProjectDatabasesOnSwarmNetwork,
  ensureProjectSwarmNetwork,
} from "../services/projects.js"
import { purgeCloudflareForApp } from "../cloudflare/purge.js"
import { logBus } from "./log-bus.js"
import { workerLog } from "./logger.js"
import { buildEnvForDeploy } from "../secrets/resolver.js"
import { classifyAppDomainWithInstanceBase } from "../domains/app-domain.js"
import { PLANS } from "@ploydok/shared"
import type { PlanName } from "@ploydok/shared"
import { healthcheckShell } from "./healthcheck-shell.js"
import {
  currentDeployLease,
  currentDeployLeaseCondition,
  DeployLeaseLostError,
  fenceDeploySideEffect,
  runOwnedDeployReconciliation,
} from "./app-deploy-lock.js"

const DEFAULT_TASK_POLL_MS = 2_000
const DEFAULT_TASK_TIMEOUT_MS = 180_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function grpcUnary<Res>(
  fn: (...args: any[]) => grpc.ClientUnaryCall,
  req: unknown
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    fn(req, (err: grpc.ServiceError | null, res: Res) => {
      if (err) reject(err)
      else resolve(res)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runtimeServiceName(app: { id: string; slug: string }): string {
  const slug = app.slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
  const token = app.id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .slice(0, 10)
  return `ploydok-app-${slug || "app"}-${token}`
}

function resolveResourceLimits(row: {
  plan: string
  cpu_limit: number | null
  mem_limit_bytes: number | null
  pids_limit: number | null
}) {
  const plan = PLANS[row.plan as PlanName] ?? null
  return {
    cpu: row.cpu_limit ?? plan?.cpu ?? 0,
    memoryBytes: row.mem_limit_bytes ?? (plan ? plan.memMB * 1024 * 1024 : 0),
    pidsLimit: row.pids_limit ?? plan?.pids ?? 0,
  }
}

function taskIsRunning(status: string): boolean {
  const normalized = status.toLowerCase()
  return normalized.includes("up ") || normalized.includes("running")
}

function isUnavailableRollbackImage(error: unknown): boolean {
  const agentError = toAgentError(error)
  const detail = `${agentError.details} ${agentError.message}`.toLowerCase()
  return /manifest unknown|manifest .*not found|no such image|image .*not found|not found.*image|pull access denied|repository .*does not exist|failed to resolve source metadata/.test(
    detail
  )
}

class UnavailableRollbackImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnavailableRollbackImageError"
  }
}

export function taskIsHealthy(
  task: SwarmTaskSnapshot,
  hasHealthcheck = true
): boolean {
  if (task.running === false) return false
  const reportedCheck = task.healthStatus !== undefined && task.healthStatus !== "none"
  const legacyCheck = /\((?:healthy|unhealthy|health:\s*starting)\)/i.test(task.status)
  if (!hasHealthcheck && !reportedCheck && !legacyCheck) {
    if (task.running !== undefined) return task.running
    return taskIsRunning(task.status)
  }
  if (task.healthStatus !== undefined) {
    return task.running === true && task.healthStatus === "healthy"
  }
  // Older agents expose health only in the Docker status text.
  return taskIsRunning(task.status) && /\(healthy\)/i.test(task.status)
}

async function waitForServiceHealthy(opts: {
  agent: InstanceType<typeof AgentClient>
  serviceName: string
  replicas: number
  channel: string
  hasHealthcheck?: boolean
  failOnUnavailableImage?: boolean
  timeoutMs?: number
}) {
  const timeoutAt = Date.now() + (opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS)
  let last: ListServiceTasksResponse | null = null
  while (Date.now() < timeoutAt) {
    await fenceDeploySideEffect()
    last = await grpcUnary<ListServiceTasksResponse>(
      opts.agent.listServiceTasks.bind(opts.agent),
      { serviceName: opts.serviceName }
    )
    if (opts.failOnUnavailableImage) {
      const unavailableTask = last.tasks.find(
        (task) => task.error && isUnavailableRollbackImage(task.error)
      )
      if (unavailableTask) {
        throw new UnavailableRollbackImageError(unavailableTask.error)
      }
    }
    const healthy = last.tasks.filter((task) =>
      taskIsHealthy(task, opts.hasHealthcheck ?? true)
    )
    if (healthy.length >= opts.replicas) return last
    logBus.publish(
      opts.channel,
      `[swarm] waiting for healthy tasks ${healthy.length}/${opts.replicas}`
    )
    await sleep(DEFAULT_TASK_POLL_MS)
  }
  throw new Error(
    `Swarm service ${opts.serviceName} did not reach ${opts.replicas} healthy task(s): ${JSON.stringify(last?.tasks ?? [])}`
  )
}

export interface RunSwarmDeployOptions {
  appId: string
  imageRef: string
  env: Record<string, string>
  runtimePort?: number
  db: Db
  agentSocketPath?: string
  caddyBaseUrl?: string
  registryAuth?: { username: string; password: string }
  onLive?: (info: RunSwarmDeployResult) => void | Promise<void>
}

export interface RunSwarmDeployResult {
  serviceName: string
  runtimeRef: string
  routeApplied: boolean
}

export async function runSwarmDeploy(
  opts: RunSwarmDeployOptions
): Promise<RunSwarmDeployResult> {
  const { appId, imageRef, db } = opts
  const channel = `runtime:${appId}`
  const rows = await db
    .select({
      id: apps.id,
      slug: apps.slug,
      domain: apps.domain,
      runtime_port: apps.runtime_port,
      healthcheck_path: apps.healthcheck_path,
      healthcheck_port: apps.healthcheck_port,
      healthcheck_interval_s: apps.healthcheck_interval_s,
      healthcheck_timeout_s: apps.healthcheck_timeout_s,
      healthcheck_retries: apps.healthcheck_retries,
      healthcheck_start_period_s: apps.healthcheck_start_period_s,
      runtime_has_healthcheck: apps.runtime_has_healthcheck,
      plan: apps.plan,
      cpu_limit: apps.cpu_limit,
      mem_limit_bytes: apps.mem_limit_bytes,
      pids_limit: apps.pids_limit,
      project_id: apps.project_id,
      owner_id: projects.owner_id,
      replicas: apps.replicas,
      update_order: apps.update_order,
      update_parallelism: apps.update_parallelism,
      update_delay_s: apps.update_delay_s,
      update_monitor_s: apps.update_monitor_s,
      failure_action: apps.failure_action,
      stop_grace_period_s: apps.stop_grace_period_s,
      swarm_service_name: apps.swarm_service_name,
      cdn_mode: apps.cdn_mode,
      cdn_cache_ttl_s: apps.cdn_cache_ttl_s,
      cdn_cache_paths: apps.cdn_cache_paths,
      cdn_compression: apps.cdn_compression,
      cdn_image_optim: apps.cdn_image_optim,
      cdn_headers: apps.cdn_headers,
      cdn_external_provider: apps.cdn_external_provider,
    })
    .from(apps)
    .innerJoin(projects, eq(apps.project_id, projects.id))
    .where(eq(apps.id, appId))
    .limit(1)
  const app = rows[0]
  if (!app) throw new Error(`App not found: ${appId}`)

  const runtimePort = opts.runtimePort ?? app.runtime_port ?? 3000
  const hcPath = app.healthcheck_path ?? "/"
  const hcPort = app.healthcheck_port ?? runtimePort
  const replicas = Math.max(1, app.replicas ?? 1)
  const serviceName = app.swarm_service_name ?? runtimeServiceName(app)
  const agent = createAgentClient(
    opts.agentSocketPath ? { socketPath: opts.agentSocketPath } : {}
  )
  const caddy = new CaddyClient(opts.caddyBaseUrl)
  const createsService = !app.swarm_service_name
  let runtimeMutated = false
  let primaryRouteApplied = !app.domain

  try {
    logBus.publish(channel, `[swarm] ensuring single-node swarm`)
    await fenceDeploySideEffect()
    await grpcUnary<SwarmEnsureSingleNodeResponse>(
      agent.swarmEnsureSingleNode.bind(agent),
      {}
    )

    const volumes = await listRuntimeAppVolumeMounts(db, appId, {
      ensureDirectories: true,
    })
    if (replicas > 1 && volumes.some((volume) => !volume.readOnly)) {
      throw new Error(
        "Cannot run more than one replica while the app has writable local volumes"
      )
    }

    await fenceDeploySideEffect()
    const network = await ensureProjectSwarmNetwork(db, app.project_id)
    const sharedAgent = getSharedAgent()
    await fenceDeploySideEffect()
    await ensureProjectDatabasesOnSwarmNetwork(
      db,
      app.project_id,
      network,
      sharedAgent
    )
    await fenceDeploySideEffect()
    await ensureCaddyOnProjectNetwork(sharedAgent, network)
    const resourceLimits = resolveResourceLimits(app)
    const containerEnv = {
      ...opts.env,
      PORT: String(runtimePort),
      PLOYDOK_RUNTIME_MODE: "swarm",
      PLOYDOK_SERVICE_NAME: serviceName,
    }

    const spec: SwarmServiceSpec = {
      name: serviceName,
      image: imageRef,
      env: containerEnv,
      labels: {
        "ploydok.kind": "app",
        "ploydok.app_id": appId,
        "ploydok.owner_id": app.owner_id,
        "ploydok.runtime": "swarm",
        "ploydok.deploy_token": currentDeployLease()?.token ?? "unfenced",
      },
      networks: [network],
      mounts: volumes.map((volume) => ({
        hostPath: volume.hostPath,
        containerPath: volume.mountPath,
        readOnly: volume.readOnly,
      })),
      resourceLimits,
      command: [],
      user: "",
      healthcheck: {
        test: ["CMD-SHELL", healthcheckShell(hcPort, hcPath)],
        intervalSeconds: app.healthcheck_interval_s ?? 5,
        timeoutSeconds: app.healthcheck_timeout_s ?? 3,
        retries: app.healthcheck_retries ?? 6,
        startPeriodSeconds: app.healthcheck_start_period_s ?? 30,
      },
      replicas,
      runtimePort,
      updateParallelism: app.update_parallelism ?? 1,
      updateDelaySeconds: app.update_delay_s ?? 10,
      updateMonitorSeconds: app.update_monitor_s ?? 30,
      updateOrder: app.update_order ?? "start-first",
      failureAction: app.failure_action ?? "rollback",
      stopGracePeriodSeconds: app.stop_grace_period_s ?? 10,
      restartCondition: "any",
    }

    if (!app.swarm_service_name) {
      logBus.publish(channel, `[swarm] creating service ${serviceName}`)
      await fenceDeploySideEffect()
      await grpcUnary<ServiceCreateResponse>(agent.serviceCreate.bind(agent), {
        spec,
        ...(opts.registryAuth ? { registryAuth: opts.registryAuth } : {}),
      })
      runtimeMutated = true
    } else {
      logBus.publish(channel, `[swarm] updating service image ${imageRef}`)
      await fenceDeploySideEffect()
      await grpcUnary<ServiceUpdateImageResponse>(
        agent.serviceUpdateImage.bind(agent),
        {
          serviceName,
          image: imageRef,
          spec,
          replicas,
          updateParallelism: spec.updateParallelism,
          updateDelaySeconds: spec.updateDelaySeconds,
          updateMonitorSeconds: spec.updateMonitorSeconds,
          updateOrder: spec.updateOrder,
          failureAction: spec.failureAction,
          ...(opts.registryAuth ? { registryAuth: opts.registryAuth } : {}),
        }
      )
      runtimeMutated = true
    }

    await waitForServiceHealthy({
      agent,
      serviceName,
      replicas,
      channel,
      hasHealthcheck: Boolean(spec.healthcheck),
    })

    if (app.domain) {
      await fenceDeploySideEffect()
      const routingBuildId = currentDeployLease()?.buildId
      const routeResult = await publishHealthyAppRoute({
        db, appId, hostname: app.domain,
        ...(routingBuildId ? { buildId: routingBuildId } : {}),
        getCurrentRouteHost: () => caddy.getRouteHost(appId),
        proxied: app.cdn_mode === "external",
        beforePersist: fenceDeploySideEffect,
        applyRoute: async () => {
          await fenceDeploySideEffect()
          await caddy.setUpstream(appId, app.domain!, {
            host: serviceName, port: runtimePort,
          }, { cdn: app })
        },
        afterRoute: async () => {
          const aliases = await syncAppDomainAliases({
            db, appId, caddy, upstream: { host: serviceName, port: runtimePort },
            beforeSideEffect: fenceDeploySideEffect,
          })
          if (aliases.errors.length) throw new Error("Alias routing requires attention")
        },
      })
      const routeApplied = routeResult.routeApplied
      primaryRouteApplied = routeApplied
      if (routeApplied) {
        await fenceDeploySideEffect()
        await purgeCloudflareForApp(db, appId)
      } else {
        logBus.publish(
          channel,
          `[swarm] service is healthy but its primary route requires DNS/TLS action`
        )
      }
    }

    await fenceDeploySideEffect()
    const appUpdates = await db
      .update(apps)
      .set({
        runtime_mode: "swarm",
        swarm_service_name: serviceName,
        container_id: null,
        status: "running",
        runtime_has_healthcheck: Boolean(spec.healthcheck),
        updated_at: new Date(),
      })
      .where(and(eq(apps.id, appId), currentDeployLeaseCondition()))
      .returning({ id: apps.id })
    if (!appUpdates[0]) {
      throw new DeployLeaseLostError(
        "lease changed before Swarm runtime commit"
      )
    }

    const result = { serviceName, runtimeRef: serviceName, routeApplied: primaryRouteApplied }
    if (opts.onLive) await opts.onLive(result)
    logBus.publish(channel, `[swarm] service live: ${serviceName}`)
    workerLog.info(
      { appId, serviceName, imageRef, replicas },
      "swarm deploy complete"
    )
    return result
  } catch (error) {
    if (runtimeMutated && createsService) {
      await runOwnedDeployReconciliation(() =>
        grpcUnary(agent.serviceRemove.bind(agent), { serviceName })
      ).catch((cleanupError) =>
        workerLog.error(
          { appId, serviceName, cleanupError },
          "swarm: partial service reconciliation failed"
        )
      )
    } else if (runtimeMutated) {
      await runOwnedDeployReconciliation(async () => {
        await grpcUnary<ServiceRollbackResponse>(
          agent.serviceRollback.bind(agent),
          { serviceName }
        )
      }).catch((cleanupError) =>
        workerLog.error(
          { appId, serviceName, cleanupError },
          "swarm: service rollback reconciliation failed"
        )
      )
    }
    throw error
  } finally {
    agent.close()
  }
}

export async function scaleSwarmApp(appId: string, replicas: number, db: Db) {
  const rows = await db
    .select({
      service: apps.swarm_service_name,
      id: apps.id,
      build_method: apps.build_method,
      runtime_has_healthcheck: apps.runtime_has_healthcheck,
    })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1)
  const app = rows[0]
  if (!app?.service) throw new Error(`App ${appId} has no Swarm service`)
  const agent = createAgentClient()
  try {
    await grpcUnary(agent.serviceScale.bind(agent), {
      serviceName: app.service,
      replicas,
    })
    await waitForServiceHealthy({
      agent,
      serviceName: app.service,
      replicas,
      channel: `runtime:${appId}`,
      hasHealthcheck: app.runtime_has_healthcheck ?? app.build_method !== "compose",
    })
    await db
      .update(apps)
      .set({ replicas, updated_at: new Date() })
      .where(eq(apps.id, appId))
  } finally {
    agent.close()
  }
}

export async function stopSwarmApp(appId: string, db: Db) {
  const rows = await db
    .select({
      service: apps.swarm_service_name,
      services: apps.swarm_service_names,
    })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1)
  const names = [
    ...new Set(
      [rows[0]?.service, ...(rows[0]?.services ?? [])].filter(
        (name): name is string => Boolean(name)
      )
    ),
  ]
  const agent = createAgentClient()
  const caddy = new CaddyClient()
  try {
    for (const serviceName of names) {
      await grpcUnary(agent.serviceRemove.bind(agent), { serviceName })
    }
    await caddy.removeUpstream(appId)
    await db
      .update(apps)
      .set({
        status: "stopped",
        swarm_service_name: null,
        swarm_service_names: null,
        container_id: null,
        updated_at: new Date(),
      })
      .where(eq(apps.id, appId))
  } finally {
    agent.close()
  }
}

export async function rollbackSwarmApp(
  appId: string,
  db: Db,
  targetBuildId?: string
) {
  const appRows = await db
    .select({
      service: apps.swarm_service_name,
      domain: apps.domain,
      cdn_mode: apps.cdn_mode,
      build_method: apps.build_method,
      runtime_has_healthcheck: apps.runtime_has_healthcheck,
      runtime_port: apps.runtime_port,
      replicas: apps.replicas,
      update_parallelism: apps.update_parallelism,
      update_delay_s: apps.update_delay_s,
      update_monitor_s: apps.update_monitor_s,
      update_order: apps.update_order,
      failure_action: apps.failure_action,
    })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1)
  const app = appRows[0]
  if (!app?.service) throw new Error(`App ${appId} has no Swarm service`)

  const targets = await db.select({
    id: builds.id, image_tag: builds.image_tag, routing_domain: builds.routing_domain,
  }).from(builds).where(and(
    eq(builds.app_id, appId),
    ...(targetBuildId ? [eq(builds.id, targetBuildId)] : [inArray(builds.status, ["succeeded", "succeeded_with_warning"])]),
  )).orderBy(desc(builds.created_at)).limit(targetBuildId ? 1 : 2)
  const target = targets[targetBuildId ? 0 : 1]
  if (targetBuildId && !target) {
    throw new Error(`Rollback target not found for app ${appId}`)
  }
  const domain = target?.routing_domain ?? app.domain
  const agent = createAgentClient()
  let runtimeMutated = false
  let useNativeRollback = !target || !target.image_tag
  let nativeRollbackApplied = false
  try {
    if (useNativeRollback) {
      workerLog.info(
        { appId, serviceName: app.service },
        "swarm rollback: no historical image available, using native service rollback"
      )
      await fenceDeploySideEffect()
      runtimeMutated = true
      await grpcUnary<ServiceRollbackResponse>(
        agent.serviceRollback.bind(agent),
        { serviceName: app.service }
      )
      nativeRollbackApplied = true
    } else {
      if (!target?.image_tag) {
        throw new Error(`Rollback build ${target?.id ?? targetBuildId} has no image tag`)
      }
      try {
        await fenceDeploySideEffect()
        await grpcUnary(agent.serviceUpdateImage.bind(agent), {
          serviceName: app.service,
          image: target.image_tag,
          replicas: app.replicas ?? 1,
          updateParallelism: app.update_parallelism ?? 1,
          updateDelaySeconds: app.update_delay_s ?? 10,
          updateMonitorSeconds: app.update_monitor_s ?? 30,
          updateOrder: app.update_order ?? "start-first",
          failureAction: app.failure_action ?? "rollback",
        })
        runtimeMutated = true
      } catch (error) {
        if (!isUnavailableRollbackImage(error)) throw error
        workerLog.warn(
          { appId, serviceName: app.service, image: target.image_tag },
          "swarm rollback: historical image unavailable, using native service rollback"
        )
        useNativeRollback = true
        await fenceDeploySideEffect()
        runtimeMutated = true
        await grpcUnary<ServiceRollbackResponse>(
          agent.serviceRollback.bind(agent),
          { serviceName: app.service }
        )
        nativeRollbackApplied = true
      }
    }
    const hasHealthcheck =
      app.runtime_has_healthcheck ?? app.build_method !== "compose"
    try {
      await waitForServiceHealthy({
        agent,
        serviceName: app.service,
        replicas: app.replicas ?? 1,
        channel: `runtime:${appId}`,
        hasHealthcheck,
        failOnUnavailableImage: !useNativeRollback,
      })
    } catch (error) {
      if (
        useNativeRollback ||
        !(error instanceof UnavailableRollbackImageError)
      ) {
        throw error
      }
      workerLog.warn(
        { appId, serviceName: app.service },
        "swarm rollback: task reported unavailable historical image, using native service rollback"
      )
      useNativeRollback = true
      await fenceDeploySideEffect()
      runtimeMutated = true
      await grpcUnary<ServiceRollbackResponse>(
        agent.serviceRollback.bind(agent),
        { serviceName: app.service }
      )
      nativeRollbackApplied = true
      await waitForServiceHealthy({
        agent,
        serviceName: app.service,
        replicas: app.replicas ?? 1,
        channel: `runtime:${appId}`,
        hasHealthcheck,
      })
    }
    if (domain) {
      await withDomainLock(db, domain, async (tx, hostname) => {
        await assertDomainAvailable(tx, hostname, { excludeAppId: appId })
      })
      const caddy = new CaddyClient()
      const upstream = { host: app.service, port: app.runtime_port ?? 3000 }
      const routeResult = await publishHealthyAppRoute({
        db, appId, hostname: domain,
        getCurrentRouteHost: () => caddy.getRouteHost(appId),
        proxied: app.cdn_mode === "external",
        beforePersist: fenceDeploySideEffect,
        applyRoute: async () => {
          await fenceDeploySideEffect()
          await caddy.setUpstream(appId, domain, upstream)
        },
        afterRoute: async () => {
          const aliases = await syncAppDomainAliases({ db, appId, caddy, upstream, beforeSideEffect: fenceDeploySideEffect })
          if (aliases.errors.length) throw new Error("Alias routing requires attention")
        },
      })
      const routeApplied = routeResult.routeApplied
      if (!routeApplied) {
        logBus.publish(
          `runtime:${appId}`,
          `[swarm] rollback service is healthy but its primary route requires DNS/TLS action`
        )
      }
    }
    await fenceDeploySideEffect()
    await db.update(apps).set({
      ...(domain
        ? {
            domain,
            domain_source: classifyAppDomainWithInstanceBase(domain),
          }
        : {}),
      status: "running",
      updated_at: new Date(),
    })
      .where(and(eq(apps.id, appId), currentDeployLeaseCondition()))
  } catch (error) {
    if (runtimeMutated && (!useNativeRollback || nativeRollbackApplied)) {
      await runOwnedDeployReconciliation(async () => {
        await grpcUnary<ServiceRollbackResponse>(
          agent.serviceRollback.bind(agent),
          { serviceName: app.service }
        )
      }).catch((cleanupError) =>
        workerLog.error(
          { appId, serviceName: app.service, cleanupError },
          "swarm rollback: failed to restore the previous service snapshot"
        )
      )
    }
    throw error
  } finally {
    agent.close()
  }
}

export async function listSwarmTasks(appId: string, db: Db) {
  const rows = await db
    .select({ service: apps.swarm_service_name })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1)
  const service = rows[0]?.service
  if (!service) return []
  const agent = createAgentClient()
  try {
    const result = await grpcUnary<ListServiceTasksResponse>(
      agent.listServiceTasks.bind(agent),
      { serviceName: service }
    )
    return result.tasks
  } finally {
    agent.close()
  }
}

export async function loadRuntimeEnv(db: Db, appId: string) {
  return buildEnvForDeploy(db, appId, "prod", "runtime")
}
