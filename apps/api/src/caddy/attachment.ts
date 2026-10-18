// SPDX-License-Identifier: AGPL-3.0-only
//
// Caddy ↔ project-network attachment.
//
// Workloads live on a per-project network (bridge for legacy docker apps,
// attachable overlay for Swarm). Caddy joins those networks so it can reach
// upstreams by container id or Swarm DNS while remaining the only ingress.
// Projects never share a data-plane network.

import { and, eq, inArray, isNotNull } from "drizzle-orm"
import { apps as appsTable, projects as projectsTable, services as servicesTable } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import type { Agent } from "../agent"
import { isAlreadyExists, isNotFound, toAgentError } from "../agent/index.js"
import { childLogger } from "../logger"
import { projectNetworkName } from "../services/projects.js"

function overlayNameForProject(projectId: string): string {
  return `ploydok-swarm-proj-${projectId.toLowerCase()}`
}

const log = childLogger("caddy-attach")

const CADDY_COMPOSE_NAMES = new Set(["ploydok-caddy", "ploydok-caddy-1"])

export type CaddyContainerLite = {
  id: string
  name: string
  kind?: string
  status?: string
}

export type RunningAppNetworkRow = {
  runtime_mode: string | null
  status: string | null
  project_id: string
  network_name: string | null
  swarm_network_name: string | null
}

function normalizeContainerName(name: string): string {
  return name.replace(/^\//, "")
}

export function isCaddyIngressContainer(
  container: CaddyContainerLite
): boolean {
  const name = normalizeContainerName(container.name)
  if (/caddy[-_]admin/i.test(name)) return false
  if (CADDY_COMPOSE_NAMES.has(name)) return true
  if (/^ploydok[_-]caddy\.\d+\./.test(name)) return true
  return (
    container.kind === "infra" &&
    /(?:^|[-_])caddy(?:$|[.\-_])/i.test(name)
  )
}

function caddyStatusRank(status: string | undefined): number {
  const normalized = (status ?? "").toLowerCase()
  if (normalized.includes("unhealthy")) return 1
  if (normalized === "running" || normalized.includes("healthy")) return 3
  if (normalized.includes("starting")) return 2
  return 0
}

export function pickCaddyIngressContainer(
  containers: CaddyContainerLite[]
): CaddyContainerLite | null {
  const matches = containers.filter(isCaddyIngressContainer)
  if (matches.length === 0) return null
  return [...matches].sort(
    (left, right) => caddyStatusRank(right.status) - caddyStatusRank(left.status)
  )[0] ?? null
}

export function networksToAttachForRunningApps(
  rows: RunningAppNetworkRow[]
): string[] {
  const networks = new Set<string>()
  for (const row of rows) {
    if (!["running", "restarting"].includes(row.status ?? "")) continue
    if (row.runtime_mode === "swarm") {
      networks.add(
        row.swarm_network_name ?? overlayNameForProject(row.project_id)
      )
      continue
    }
    if (row.network_name) networks.add(row.network_name)
  }
  return [...networks]
}

/**
 * Lazy cache for the Caddy container id. Docker does not re-allocate an id
 * while the container is alive; we only refresh it if a `network_connect`
 * fails with NOT_FOUND (the container was recreated).
 */
let cachedCaddyId: string | null = null

/** Reset the cache — exposed for tests or post-restart reconciliation. */
export function resetCaddyIdCache(): void {
  cachedCaddyId = null
}

async function resolveCaddyContainerId(agent: Agent): Promise<string> {
  if (cachedCaddyId) return cachedCaddyId
  const { containers } = await agent.listContainers({ kindFilter: "" })
  const match = pickCaddyIngressContainer(containers)
  if (match) {
    cachedCaddyId = match.id
    log.debug(
      { caddyId: match.id, name: match.name },
      "resolved caddy container"
    )
    return match.id
  }
  throw new Error(
    "caddy container not found (expected compose name ploydok-caddy[-1] or Swarm task ploydok_caddy.*). Is ingress running?"
  )
}

/**
 * Ensure Caddy is attached to `projectNetwork`. Idempotent: treats Docker's
 * 409 "already exists" as success. Safe to call on every deploy.
 */
export async function ensureCaddyOnProjectNetwork(
  agent: Agent,
  projectNetwork: string,
): Promise<void> {
  const caddyId = await resolveCaddyContainerId(agent)
  try {
    await agent.networkConnect({
      networkId: projectNetwork,
      containerId: caddyId,
      aliases: [],
    })
    log.info({ projectNetwork, caddyId }, "caddy attached to project network")
  } catch (err) {
    const agentErr = toAgentError(err)
    if (isAlreadyExists(agentErr)) {
      log.debug({ projectNetwork, caddyId }, "caddy already on project network")
      return
    }
    // NOT_FOUND on the container id almost always means Caddy was recreated
    // (compose down/up). Invalidate the cache and retry once.
    if (isNotFound(agentErr) && /container/i.test(agentErr.details)) {
      resetCaddyIdCache()
      const freshId = await resolveCaddyContainerId(agent)
      await agent.networkConnect({
        networkId: projectNetwork,
        containerId: freshId,
        aliases: [],
      })
      log.info({ projectNetwork, caddyId: freshId }, "caddy re-attached after cache refresh")
      return
    }
    throw err
  }
}

/**
 * Detach Caddy from `projectNetwork`. Called at project deletion right before
 * `network_remove` (Docker refuses to delete a network with active endpoints).
 * Idempotent: missing endpoint / missing network are non-fatal.
 */
export async function detachCaddyFromProjectNetwork(
  agent: Agent,
  projectNetwork: string,
): Promise<void> {
  let caddyId: string
  try {
    caddyId = await resolveCaddyContainerId(agent)
  } catch {
    // Caddy itself is gone — nothing to do.
    return
  }
  try {
    await agent.networkDisconnect({
      networkId: projectNetwork,
      containerId: caddyId,
      force: true,
    })
    log.info({ projectNetwork, caddyId }, "caddy detached from project network")
  } catch (err) {
    if (isNotFound(toAgentError(err))) {
      log.debug({ projectNetwork }, "caddy not on project network — nothing to detach")
      return
    }
    throw err
  }
}

/**
 * Boot-time reconciliation: attach Caddy to every live project network.
 * Swarm apps use the overlay; leftover docker apps keep the bridge.
 */
export async function reconcileCaddyAttachments(
  agent: Agent,
  db: Db
): Promise<{ attached: number; skipped: number; failed: number }> {
  const rows = await db
    .select({
      runtime_mode: appsTable.runtime_mode,
      status: appsTable.status,
      project_id: projectsTable.id,
      network_name: projectsTable.network_name,
      swarm_network_name: projectsTable.swarm_network_name,
    })
    .from(appsTable)
    .innerJoin(projectsTable, eq(appsTable.project_id, projectsTable.id))
    .where(inArray(appsTable.status, ["running", "restarting"]))


  const publicServices = await db.select({
    project_id: projectsTable.id,
    runtime_mode: servicesTable.runtime_mode,
    network_name: projectsTable.network_name,
    swarm_network_name: projectsTable.swarm_network_name,
  }).from(servicesTable)
    .innerJoin(projectsTable, eq(servicesTable.project_id, projectsTable.id))
    .where(and(eq(servicesTable.status, "running"), isNotNull(servicesTable.domain)))
  const networks = [...new Set([
    ...networksToAttachForRunningApps(rows),
    ...publicServices.map(row =>
      row.runtime_mode === "docker"
        ? row.network_name ?? projectNetworkName(row.project_id)
        : row.swarm_network_name ?? overlayNameForProject(row.project_id)
    ),
  ])]
  const result = { attached: 0, skipped: 0, failed: 0 }
  if (networks.length === 0) {
    result.skipped++
    log.info(result, "caddy attachments reconciled")
    return result
  }
  for (const name of networks) {
    try {
      await ensureCaddyOnProjectNetwork(agent, name)
      result.attached++
    } catch (err) {
      log.warn({ err, projectNetwork: name }, "reconcile: caddy attach failed")
      result.failed++
    }
  }
  log.info(result, "caddy attachments reconciled")
  return result
}
