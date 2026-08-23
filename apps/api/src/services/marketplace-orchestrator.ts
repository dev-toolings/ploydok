// SPDX-License-Identifier: AGPL-3.0-only
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
} from "@ploydok/db/queries"
import type { ServiceRow, Db } from "@ploydok/db"
import { resolveTemplate } from "@ploydok/shared"
import { childLogger } from "../logger"
import type { Agent } from "../agent"
import type { CaddyClient } from "../caddy/client.js"
import { getSharedCaddy, getSharedAgent } from "../debug/singletons.js"
import { createAgentClient } from "../agent/client.js"
import { removeServiceRoute } from "../caddy/service-routes.js"
import { ensureCaddyOnProjectNetwork } from "../caddy/attachment.js"
import { ensureProjectSwarmNetwork } from "./projects.js"
import {
  deployPlannedComposeStack,
  planComposeSwarmDeploy,
  removeComposeSwarmServices,
  swarmAgentFromGrpc,
  type ComposeSwarmAgent,
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
  const { agent, db } = deps
  const caddy = deps.caddy ?? getSharedCaddy()

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

  const row = await insertService(db, {
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

  const swarm = deps.swarm ?? swarmAgentFromGrpc(createAgentClient())

  ;(async () => {
    try {
      const network = await ensureProjectSwarmNetwork(db, input.projectId)
      await ensureCaddyOnProjectNetwork(getSharedAgent(), network)
      const plan = planComposeSwarmDeploy({
        compose: composeResolved,
        kindToken: `svc-${slug}`.slice(0, 40),
        network,
        labels: {
          "ploydok.kind": "service",
          "ploydok.service_id": serviceId,
          "ploydok.app_id": serviceId,
          "ploydok.owner_id": userId,
        },
      })
      const names = await deployPlannedComposeStack(swarm, plan)
      await updateServiceSwarmNames(db, serviceId, names)
      await updateServiceStatus(db, serviceId, "running")

      if (domain && plan.entrypoint) {
        try {
          await caddy.upsertRoute({
            host: domain,
            upstream: `${plan.entrypoint.name}:${plan.entrypoint.port}`,
            appId: serviceId,
          })
        } catch (err) {
          log.warn({ err, serviceId, domain }, "Caddy route upsert failed")
        }
      }

      log.info(
        { serviceId, slug, serviceCount: names.length },
        "service deployed"
      )
    } catch (err) {
      log.error({ err, serviceId }, "service install failed")
      await updateServiceStatus(db, serviceId, "failed").catch((e) =>
        log.error(
          { e },
          "failed to update service status after install failure"
        )
      )
    }
  })()

  return row
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

  if ((svc.swarm_service_names ?? []).length > 0) {
    await updateServiceStatus(db, serviceId, "running")
    return
  }
  if (svc.compose_raw && (svc.container_ids ?? []).length === 0) {
    const swarm = deps.swarm ?? swarmAgentFromGrpc(createAgentClient())
    const network = await ensureProjectSwarmNetwork(db, svc.project_id)
    await ensureCaddyOnProjectNetwork(getSharedAgent(), network)
    const plan = planComposeSwarmDeploy({
      compose: svc.compose_raw,
      kindToken: `svc-${svc.slug}`.slice(0, 40),
      network,
      labels: {
        "ploydok.kind": "service",
        "ploydok.service_id": serviceId,
        "ploydok.app_id": serviceId,
        "ploydok.owner_id": userId,
      },
    })
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

  const swarmNames = svc.swarm_service_names ?? []
  if (swarmNames.length > 0) {
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

  const swarmNames = svc.swarm_service_names ?? []
  if (swarmNames.length > 0) {
    const swarm = deps.swarm ?? swarmAgentFromGrpc(createAgentClient())
    await removeComposeSwarmServices(swarm, swarmNames)
  }

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
