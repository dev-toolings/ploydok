// SPDX-License-Identifier: AGPL-3.0-only
import { protectServiceSecrets, resolveServiceCompose } from "./service-secrets"
import { nanoid } from "nanoid"
import { eq } from "drizzle-orm"
import { services, projects } from "@ploydok/db"
import {
  insertService,
  updateServiceStatus,
  updateServiceContainers,
  updateServiceSwarmNames,
  markServiceDeleting,
  uniqueServiceSlug,
  getServiceForUser,
  hasRole,
  getServiceById,
  createCreationSaga,
  claimCreationSaga,
  fenceCreationSaga,
  recordClaimedCreationSagaStep,
  completeClaimedCreationSaga,
  beginClaimedCreationSagaCompensation,
  completeClaimedCreationSagaCompensation,
  retryClaimedCreationSaga,
} from "@ploydok/db/queries"
import type { ServiceRow, Db } from "@ploydok/db"
import { resolveTemplate } from "@ploydok/shared"
import { childLogger } from "../logger"
import { enqueueWithDbRow } from "../worker/queue-enqueue"
import { serviceInstallQueue } from "../worker/queues"
import { isAlreadyExists, isNotFound, toAgentError } from "../agent"
import type { Agent } from "../agent"
import type { CaddyClient } from "../caddy/client.js"
import { getSharedCaddy, getSharedAgent } from "../debug/singletons.js"
import { createAgentClient } from "../agent/client.js"
import {
  removeServiceRoute,
  ServiceHasNoEntrypointError,
  upsertServiceRoute,
} from "../caddy/service-routes.js"
import { ensureCaddyOnProjectNetwork } from "../caddy/attachment.js"
import { ensureProjectNetwork, ensureProjectSwarmNetwork } from "./projects.js"
import {
  composeRequiresContainerRuntime,
  composeToContainers,
  type ComposeContainer,
} from "../marketplace/compose-to-containers.js"
import {
  deployPlannedComposeStack,
  planComposeSwarmDeploy,
  plannedServiceToSpec,
  removeComposeSwarmServices,
  swarmAgentFromGrpc,
  type ComposeSwarmAgent,
  type PlannedComposeStack,
} from "../worker/compose-swarm.js"

const log = childLogger("marketplace-orchestrator")

export interface OrchestratorDeps {
  agent: Pick<
    Agent,
    | "imagePull"
    | "containerCreate"
    | "containerStart"
    | "containerStop"
    | "containerRemove"
    | "listContainers"
  >
  db: Db
  caddy?: Pick<CaddyClient, "upsertRoute" | "removeRoute">
  swarm?: ComposeSwarmAgent
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
}

/**
 * Slugs are only unique per project, so the Swarm name carries the service id:
 * a create that reports AlreadyExists can then only be this service's replay.
 */
export function planServiceStack(
  service: Pick<ServiceRow, "id" | "slug" | "compose_raw">,
  network: string,
  ownerId: string
): PlannedComposeStack {
  return planComposeSwarmDeploy({
    compose: service.compose_raw,
    kindToken: `svc-${service.id}-${service.slug}`.slice(0, 40),
    network,
    labels: {
      "ploydok.kind": "service",
      "ploydok.service_id": service.id,
      "ploydok.app_id": service.id,
      "ploydok.owner_id": ownerId,
    },
  })
}

export function planServiceContainers(
  service: Pick<ServiceRow, "id" | "compose_raw">,
  network: string,
  ownerId: string
): ComposeContainer[] {
  return composeToContainers({
    compose: service.compose_raw,
    runtime: "docker",
    servicePrefix: `ploydok-svc-${service.id}`,
    network,
    labels: {
      "ploydok.kind": "service",
      "ploydok.service_id": service.id,
      "ploydok.app_id": service.id,
      "ploydok.owner_id": ownerId,
      "ploydok.runtime": "docker",
    },
  })
}

function serviceRuntimeMode(
  service: Pick<ServiceRow, "runtime_mode" | "container_ids" | "swarm_service_names">
): "docker" | "swarm" {
  // The fallback keeps rows written before the runtime_mode migration
  // operable while all new rows use the persisted column.
  return (
    service.runtime_mode ??
    (service.swarm_service_names?.length ? "swarm" : "docker")
  )
}

function agentPortsForContainer(container: ComposeContainer) {
  return container.ports
    .filter((port) => port.hostIp)
    .map((port) => ({ ...port, hostIp: port.hostIp! }))
}

export async function installFromTemplate(
  deps: OrchestratorDeps,
  userId: string,
  input: {
    projectId: string
    templateId: string
    templateVersion: string
    name: string
    compose: string
  }
): Promise<ServiceRow> {
  const { db } = deps

  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1)
  if (!projectRows[0]) {
    throw Object.assign(new Error("Project not found"), { code: "NOT_FOUND" })
  }
  if (!(await hasRole(db, input.projectId, userId, ["owner"]))) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" })
  }

  const serviceId = nanoid()
  const baseSlug = slugify(input.name) || "service"
  const slug = await uniqueServiceSlug(db, input.projectId, baseSlug)

  const { composeResolved, generatedVars, domain } = resolveTemplate(
    input.compose,
    {
      projectSlug: slug,
    }
  )

  const runtimeMode = composeRequiresContainerRuntime(composeResolved)
    ? "docker"
    : "swarm"
  // Validate before accepting the durable intention. The resolved input remains
  // on the service row; the outbox contains only its identifier.
  if (runtimeMode === "docker") {
    planServiceContainers(
      { id: serviceId, compose_raw: composeResolved },
      "validation",
      userId
    )
  } else {
    planServiceStack(
      { id: serviceId, slug, compose_raw: composeResolved },
      "validation",
      userId
    )
  }
  const protectedValues = await protectServiceSecrets(composeResolved, generatedVars)
  const accepted = await enqueueWithDbRow({
    db,
    queue: serviceInstallQueue,
    jobName: "service.install.requested",
    insertRow: async (tx) => {
      const row = await insertService(tx, {
        id: serviceId,
        project_id: input.projectId,
        name: input.name,
        slug,
        template_id: input.templateId,
        template_version: input.templateVersion,
        status: "pending",
        runtime_mode: runtimeMode,
        ...protectedValues,
        domain,
        container_ids: [],
      })
      await createCreationSaga(tx, {
        resourceType: "service",
        resourceId: serviceId,
        projectId: input.projectId,
        requestedByUserId: userId,
        completedSteps: ["service_persisted"],
      })
      return row
    },
    buildPayload: (row) => ({ serviceId: row.id }),
  })
  return accepted.row
}

/** Shared by the outbox worker and the existing resource creation reconciler. */
export async function resumeServiceCreation(
  deps: OrchestratorDeps,
  serviceId: string
): Promise<boolean> {
  const { db } = deps
  const caddy = deps.caddy ?? getSharedCaddy()
  const swarm = deps.swarm ?? swarmAgentFromGrpc(createAgentClient())
  const claim = await claimCreationSaga(db, "service", serviceId)
  if (!claim) return false
  const token = claim.token
  let compensating = claim.saga.state === "compensating"
  async function fence() {
    if (!(await fenceCreationSaga(db, "service", serviceId, token))) {
      throw new Error("service creation saga lease lost")
    }
  }
  try {
    const service = await getServiceById(db, serviceId)
    const runtimeMode = service ? serviceRuntimeMode(service) : "swarm"
    const discovered =
      service && runtimeMode === "docker"
        ? (await deps.agent.listContainers({ kindFilter: "service" })).containers
        : []
    const discoveredForService = discovered.filter(
      (container) => container.serviceId === serviceId
    )
    const containerIds = [
      ...new Set([
        ...(service?.container_ids ?? []),
        ...(claim.saga.owned_resources.containerIds ?? []),
        ...discoveredForService.map((container) => container.id),
      ]),
    ]
    const swarmNames = [
      ...new Set([
        ...(service?.swarm_service_names ?? []),
        ...(claim.saga.owned_resources.swarmServiceNames ?? []),
      ]),
    ]
    const ownerId = claim.saga.requested_by_user_id
    compensating ||=
      !service ||
      service.status === "deleting" ||
      !ownerId ||
      claim.saga.attempt_count >= claim.saga.max_attempts
    if (compensating || !service || !ownerId) {
      if (
        !(await beginClaimedCreationSagaCompensation(
          db,
          "service",
          serviceId,
          token
        ))
      )
        throw new Error("service compensation lease lost")
      await fence()
      await removeServiceRoute(caddy, serviceId)
      for (const containerId of [...containerIds].reverse()) {
        await fence()
        try {
          await deps.agent.containerRemove({
            containerId,
            force: true,
            removeVolumes: false,
          })
        } catch (error) {
          if (!isNotFound(toAgentError(error))) throw error
        }
      }
      for (const serviceName of [...swarmNames].reverse()) {
        await fence()
        try {
          await swarm.serviceRemove({ serviceName })
        } catch (error) {
          if (!isNotFound(toAgentError(error))) throw error
        }
      }
      await db.transaction(async (tx) => {
        if (!(await fenceCreationSaga(tx, "service", serviceId, token)))
          throw new Error("service compensation lease lost")
        if (service) {
          if (runtimeMode === "docker") {
            await updateServiceContainers(tx as unknown as Db, serviceId, [])
          } else {
            await updateServiceSwarmNames(tx as unknown as Db, serviceId, [])
          }
          await updateServiceStatus(tx as unknown as Db, serviceId, "failed")
        }
        if (
          !(await completeClaimedCreationSagaCompensation(
            tx,
            "service",
            serviceId,
            token,
            "service creation compensated"
          ))
        )
          throw new Error("service compensation lease lost")
      })
      return true
    }

    await fence()
    const compose = await resolveServiceCompose(service)
    if (runtimeMode === "docker") {
      const network = await ensureProjectNetwork(db, service.project_id)
      if (service.domain) await ensureCaddyOnProjectNetwork(getSharedAgent(), network)
      const containers = planServiceContainers(
        { id: service.id, compose_raw: compose },
        network,
        ownerId
      )
      async function recordContainer(containerId: string, name: string) {
        if (!containerIds.includes(containerId)) containerIds.push(containerId)
        await db.transaction(async (tx) => {
          if (
            !(await recordClaimedCreationSagaStep(
              tx,
              "service",
              serviceId,
              token,
              `container:${name}`,
              { containerIds }
            ))
          ) {
            throw new Error(
              "service creation saga lease lost while recording container"
            )
          }
          await updateServiceContainers(tx as unknown as Db, serviceId, [
            ...containerIds,
          ])
        })
      }

      for (const spec of containers) {
        await fence()
        const existing = discoveredForService.find(
          (container) => container.name.replace(/^\//, "") === spec.name
        )
        let containerId = existing?.id
        if (!containerId) {
          for await (const _progress of deps.agent.imagePull({
            image: spec.image,
            registryAuth: undefined,
          })) {
            await fence()
          }
          await fence()
          const created = await deps.agent.containerCreate({
            name: spec.name,
            image: spec.image,
            env: spec.env,
            labels: spec.labels,
            network: spec.networks[0] ?? "",
            networks: spec.networks,
            ports: agentPortsForContainer(spec),
            volumes: spec.volumes,
            command: spec.command,
            restartPolicy: spec.restartPolicy,
            resourceLimits: undefined,
            user: spec.user ?? "",
            healthcheck: spec.healthcheck
              ? {
                  test: spec.healthcheck.test,
                  intervalSeconds: spec.healthcheck.intervalSeconds ?? 0,
                  timeoutSeconds: spec.healthcheck.timeoutSeconds ?? 0,
                  retries: spec.healthcheck.retries ?? 0,
                  startPeriodSeconds: spec.healthcheck.startPeriodSeconds ?? 0,
                }
              : undefined,
          })
          containerId = created.containerId
        }
        if (!containerId) throw new Error(`container ${spec.name} has no id`)
        await recordContainer(containerId, spec.name)
        await fence()
        await deps.agent.containerStart({ containerId })
      }
      if (service.domain && containers.length) {
        await fence()
        try {
          await upsertServiceRoute(caddy, {
            serviceId,
            domain: service.domain,
            containers,
          })
        } catch (error) {
          if (!(error instanceof ServiceHasNoEntrypointError)) throw error
        }
      }
      log.info({ serviceId, serviceCount: containers.length }, "service deployed")
    } else {
      const network = await ensureProjectSwarmNetwork(db, service.project_id)
      if (service.domain) await ensureCaddyOnProjectNetwork(getSharedAgent(), network)
      const plan = planServiceStack({ ...service, compose_raw: compose }, network, ownerId)
      const planned = plan.services.map((s) => s.name)
      // Every name is recorded before the first Swarm side effect, so a crash
      // between two creations still hands compensation the complete list.
      await db.transaction(async (tx) => {
        if (
          !(await recordClaimedCreationSagaStep(
            tx,
            "service",
            serviceId,
            token,
            "swarm_planned",
            { swarmServiceNames: planned }
          ))
        )
          throw new Error("service creation saga lease lost while planning")
        await updateServiceSwarmNames(tx as unknown as Db, serviceId, planned)
      })
      await fence()
      await swarm.swarmEnsureSingleNode({})
      for (const spec of plan.services) {
        await fence()
        try {
          await swarm.serviceCreate({ spec: plannedServiceToSpec(spec) })
        } catch (error) {
          if (!isAlreadyExists(toAgentError(error))) throw error
        }
      }
      if (service.domain && plan.entrypoint) {
        await fence()
        await caddy.upsertRoute({
          host: service.domain,
          upstream: `${plan.entrypoint.name}:${plan.entrypoint.port}`,
          appId: serviceId,
        })
      }
      log.info({ serviceId, serviceCount: planned.length }, "service deployed")
    }
    await db.transaction(async (tx) => {
      if (!(await fenceCreationSaga(tx, "service", serviceId, token)))
        throw new Error("service creation saga lease lost at completion")
      await updateServiceStatus(tx as unknown as Db, serviceId, "running")
      if (!(await completeClaimedCreationSaga(tx, "service", serviceId, token)))
        throw new Error("service creation saga lease lost at completion")
    })
    return true
  } catch (error) {
    await retryClaimedCreationSaga(
      db,
      "service",
      serviceId,
      token,
      error,
      new Date(Date.now() + 5_000),
      new Date(),
      compensating ? "compensating" : "failed"
    )
    throw error
  }
}

export async function startService(
  deps: OrchestratorDeps,
  userId: string,
  serviceId: string
): Promise<void> {
  const { agent, db } = deps

  const svc = await getServiceForUser(db, serviceId, userId)
  if (!svc)
    throw Object.assign(new Error("Service not found"), { code: "NOT_FOUND" })
  if (svc.status !== "stopped" && svc.status !== "failed") {
    throw Object.assign(
      new Error(`Service is not in a startable state (current: ${svc.status})`),
      { code: "CONFLICT" }
    )
  }

  if (serviceRuntimeMode(svc) === "swarm") {
    if ((svc.swarm_service_names ?? []).length > 0) {
      await updateServiceStatus(db, serviceId, "running")
      return
    }
    const swarm = deps.swarm ?? swarmAgentFromGrpc(createAgentClient())
    const network = await ensureProjectSwarmNetwork(db, svc.project_id)
    if (svc.domain) await ensureCaddyOnProjectNetwork(getSharedAgent(), network)
    const plan = planServiceStack({ ...svc, compose_raw: await resolveServiceCompose(svc) }, network, userId)
    const names = await deployPlannedComposeStack(swarm, plan)
    await updateServiceSwarmNames(db, serviceId, names)
    await updateServiceStatus(db, serviceId, "running")
    return
  }
  for (const containerId of svc.container_ids ?? []) {
    await agent.containerStart({ containerId })
  }
  await updateServiceStatus(db, serviceId, "running")
}

export async function stopService(
  deps: OrchestratorDeps,
  userId: string,
  serviceId: string
): Promise<void> {
  const { agent, db } = deps

  const svc = await getServiceForUser(db, serviceId, userId)
  if (!svc)
    throw Object.assign(new Error("Service not found"), { code: "NOT_FOUND" })
  if (svc.status !== "running") {
    throw Object.assign(
      new Error(`Service is not running (current: ${svc.status})`),
      { code: "CONFLICT" }
    )
  }

  if (serviceRuntimeMode(svc) === "swarm") {
    const swarmNames = svc.swarm_service_names ?? []
    const swarm = deps.swarm ?? swarmAgentFromGrpc(createAgentClient())
    await removeComposeSwarmServices(swarm, swarmNames)
    await updateServiceSwarmNames(db, serviceId, [])
    await updateServiceStatus(db, serviceId, "stopped")
    return
  }
  for (const containerId of [...(svc.container_ids ?? [])].reverse()) {
    await agent.containerStop({ containerId, timeoutSeconds: 10 })
  }
  await updateServiceStatus(db, serviceId, "stopped")
}

export async function deleteService(
  deps: OrchestratorDeps,
  userId: string,
  serviceId: string
): Promise<void> {
  const { agent, db } = deps
  const caddy = deps.caddy ?? getSharedCaddy()

  const svc = await getServiceForUser(db, serviceId, userId)
  if (!svc)
    throw Object.assign(new Error("Service not found"), { code: "NOT_FOUND" })

  await markServiceDeleting(db, serviceId)

  if (serviceRuntimeMode(svc) === "swarm") {
    const swarmNames = svc.swarm_service_names ?? []
    const swarm = deps.swarm ?? swarmAgentFromGrpc(createAgentClient())
    await removeComposeSwarmServices(swarm, swarmNames)
  }

  for (const containerId of serviceRuntimeMode(svc) === "docker" ? svc.container_ids ?? [] : []) {
    try {
      await agent.containerStop({ containerId, timeoutSeconds: 10 })
    } catch (err) {
      log.warn({ err, containerId }, "container stop warning during delete")
    }
    try {
      await agent.containerRemove({
        containerId,
        force: true,
        removeVolumes: true,
      })
    } catch (err) {
      log.warn({ err, containerId }, "container remove warning during delete")
    }
  }

  await removeServiceRoute(caddy, serviceId).catch((err) =>
    log.warn({ err, serviceId }, "Caddy route removal failed during delete")
  )

  await db.delete(services).where(eq(services.id, serviceId))
  log.info({ serviceId, name: svc.name }, "service deleted")
}
