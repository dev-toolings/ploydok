// SPDX-License-Identifier: AGPL-3.0-only
import { nanoid } from "nanoid"
import { eq } from "drizzle-orm"
import { services, projects } from "@ploydok/db"
import {
  insertService,
  updateServiceStatus,
  updateServiceContainers,
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
import { isNotFound, toAgentError } from "../agent"
import type { Agent } from "../agent"
import type { CaddyClient } from "../caddy/client.js"
import { getSharedCaddy } from "../debug/singletons.js"
import {
  upsertServiceRoute,
  removeServiceRoute,
  ServiceHasNoEntrypointError,
} from "../caddy/service-routes.js"

import {
  composeToContainers,
  type ComposeContainer,
} from "../marketplace/compose-to-containers"

function topoOrder(containers: ComposeContainer[]): string[] {
  const names = new Set(containers.map((c) => c.name))
  const visited = new Set<string>()
  const order: string[] = []

  function visit(name: string) {
    if (visited.has(name)) return
    visited.add(name)
    const spec = containers.find((c) => c.name === name)
    for (const dep of spec?.dependsOn ?? []) {
      if (names.has(dep)) visit(dep)
    }
    order.push(name)
  }

  for (const c of containers) visit(c.name)
  return order
}

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
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
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

  // Validate before accepting the durable intention. The resolved input remains
  // on the service row; the outbox contains only its identifier.
  serviceContainers({
    id: serviceId,
    slug,
    compose_raw: composeResolved,
  } as ServiceRow)
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
        compose_raw: composeResolved,
        generated_env: generatedVars,
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

function serviceContainers(service: Pick<ServiceRow, "id" | "compose_raw">): ComposeContainer[] {
  return composeToContainers({
    compose: service.compose_raw,
    servicePrefix: `ploydok-svc-${service.id}`,
    network: "ploydok-public",
    labels: { "ploydok.kind": "service", "ploydok.service_id": service.id },
  })
}

/** Shared by the outbox worker and the existing resource creation reconciler. */
export async function resumeServiceCreation(
  deps: OrchestratorDeps,
  serviceId: string
): Promise<boolean> {
  const { db, agent } = deps
  const caddy = deps.caddy ?? getSharedCaddy()
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
    const snapshot = await agent.listContainers({ kindFilter: "service" })
    const discovered = snapshot.containers.filter(
      (c) => c.serviceId === serviceId
    )
    const containerIds = [
      ...new Set([
        ...(service?.container_ids ?? []),
        ...(claim.saga.owned_resources.containerIds ?? []),
        ...discovered.map((c) => c.id),
      ]),
    ]
    compensating ||=
      !service ||
      service.status === "deleting" ||
      !claim.saga.requested_by_user_id ||
      claim.saga.attempt_count >= claim.saga.max_attempts
    if (compensating) {
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
          await agent.containerRemove({
            containerId,
            force: true,
            removeVolumes: false,
          })
        } catch (error) {
          if (!isNotFound(toAgentError(error))) throw error
        }
      }
      await db.transaction(async (tx) => {
        if (!(await fenceCreationSaga(tx, "service", serviceId, token)))
          throw new Error("service compensation lease lost")
        if (service) {
          await updateServiceContainers(tx as unknown as Db, serviceId, [])
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
    const containers = serviceContainers(service!)
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
        )
          throw new Error(
            "service creation saga lease lost while recording container"
          )
        await updateServiceContainers(tx as unknown as Db, serviceId, [
          ...containerIds,
        ])
      })
    }
    for (const name of topoOrder(containers)) {
      const spec = containers.find((c) => c.name === name)!
      await fence()
      const existing = discovered.find((c) => c.name === name)
      let containerId = existing?.id
      if (!containerId) {
        for await (const _progress of agent.imagePull({
          image: spec.image,
          registryAuth: undefined,
        }))
          await fence()
        await fence()
        const created = await agent.containerCreate({
          name: spec.name,
          image: spec.image,
          env: spec.env,
          labels: spec.labels,
          network: spec.networks[0] ?? "",
          networks: spec.networks,
          ports: spec.ports,
          volumes: spec.volumes,
          command: spec.command,
          restartPolicy: spec.restartPolicy,
          resourceLimits: undefined,
          user: "",
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
      await recordContainer(containerId, name)
      await fence()
      await agent.containerStart({ containerId })
    }
    if (service!.domain && containers.length) {
      await fence()
      try {
        await upsertServiceRoute(caddy, {
          serviceId,
          domain: service!.domain,
          containers,
        })
      } catch (error) {
        if (!(error instanceof ServiceHasNoEntrypointError)) throw error
      }
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

  for (const containerId of svc.container_ids ?? []) {
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
