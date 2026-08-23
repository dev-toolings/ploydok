// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import * as grpc from "@grpc/grpc-js"
import type { AgentClient } from "@ploydok/agent-proto"
import {
  composeToContainers,
  type ComposeContainer,
} from "../marketplace/compose-to-containers.js"

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

export function swarmAgentFromGrpc(client: AgentClient): ComposeSwarmAgent {
  return {
    swarmEnsureSingleNode: (req) =>
      grpcUnary(client.swarmEnsureSingleNode.bind(client), req),
    serviceCreate: (req) => grpcUnary(client.serviceCreate.bind(client), req),
    serviceRemove: (req) => grpcUnary(client.serviceRemove.bind(client), req),
    listServiceTasks: (req) =>
      grpcUnary(client.listServiceTasks.bind(client), req),
  }
}

export const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
] as const

const SERVICE_NAME_RE = /^ploydok-app-[a-z0-9][a-z0-9-]{0,90}$/

export type PlannedSwarmService = {
  name: string
  image: string
  env: Record<string, string>
  labels: Record<string, string>
  networks: string[]
  mounts: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>
  command: string[]
  healthcheck?: ComposeContainer["healthcheck"]
  replicas: number
  runtimePort: number
}

export type PlannedComposeStack = {
  services: PlannedSwarmService[]
  entrypoint: { name: string; port: number } | null
}

export function swarmComposeServiceName(
  kindToken: string,
  composeService: string
): string {
  const token = kindToken
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  const svc = composeService
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
  const name = `ploydok-app-${token || "svc"}-${svc || "web"}`
  if (!SERVICE_NAME_RE.test(name)) {
    throw new Error(`invalid Swarm service name: ${name}`)
  }
  return name
}

export function pickComposeEntrypoint(
  containers: ComposeContainer[]
): { name: string; port: number } | null {
  for (const container of containers) {
    const port = container.exposedPort ?? container.ports[0]?.containerPort
    if (port && port > 0) {
      return { name: container.name, port }
    }
  }
  return null
}

export function planComposeSwarmDeploy(input: {
  compose: string
  kindToken: string
  network: string
  labels: Record<string, string>
  replicas?: number
  extraEnv?: Record<string, string>
}): PlannedComposeStack {
  const replicas = Math.max(1, input.replicas ?? 1)
  const containers = composeToContainers({
    compose: input.compose,
    servicePrefix: `tmp-${input.kindToken}`,
    network: input.network,
    labels: input.labels,
  })

  if (
    replicas > 1 &&
    containers.some((container) =>
      container.volumes.some((volume) => !volume.readOnly)
    )
  ) {
    throw new Error(
      "Cannot run more than one replica while the compose stack has writable local volumes"
    )
  }

  const services: PlannedSwarmService[] = containers.map((container) => {
    const name = swarmComposeServiceName(
      input.kindToken,
      container.composeName ?? "web"
    )
    const runtimePort =
      container.exposedPort ?? container.ports[0]?.containerPort ?? 0
    const planned: PlannedSwarmService = {
      name,
      image: container.image,
      env: { ...container.env, ...input.extraEnv },
      labels: {
        ...container.labels,
        ...input.labels,
        "ploydok.runtime": "swarm",
      },
      networks: [input.network],
      mounts: container.volumes.map((volume) => ({
        hostPath: volume.hostPath,
        containerPath: volume.containerPath,
        readOnly: volume.readOnly,
      })),
      command: container.command,
      replicas,
      runtimePort,
    }
    if (container.healthcheck) planned.healthcheck = container.healthcheck
    return planned
  })

  const entrypoint = pickComposeEntrypoint(
    services.map((service, index) => ({
      ...containers[index]!,
      name: service.name,
    }))
  )

  return { services, entrypoint }
}

export async function readComposeFileFromWorkspace(
  workspacePath: string,
  rootDir?: string | null
): Promise<{ filename: string; contents: string }> {
  const root = path.join(workspacePath, rootDir ?? ".")
  const entries = new Set(await readdir(root))
  for (const filename of COMPOSE_FILENAMES) {
    if (!entries.has(filename)) continue
    const contents = await readFile(path.join(root, filename), "utf8")
    return { filename, contents }
  }
  throw new Error(
    `No compose file found (tried ${COMPOSE_FILENAMES.join(", ")})`
  )
}

export type ComposeSwarmAgent = {
  swarmEnsureSingleNode: (req: Record<string, never>) => Promise<unknown>
  serviceCreate: (req: {
    spec: Record<string, unknown>
  }) => Promise<{ serviceId?: string }>
  serviceRemove: (req: { serviceName: string }) => Promise<unknown>
  listServiceTasks?: (req: { serviceName: string }) => Promise<{
    tasks: Array<{ status: string }>
  }>
}

export function plannedServiceToSpec(
  service: PlannedSwarmService
): Record<string, unknown> {
  return {
    name: service.name,
    image: service.image,
    env: service.env,
    labels: service.labels,
    networks: service.networks,
    mounts: service.mounts,
    resourceLimits: { cpu: 0, memoryBytes: 0, pidsLimit: 0 },
    command: service.command,
    user: "",
    healthcheck: service.healthcheck
      ? {
          test: service.healthcheck.test,
          intervalSeconds: service.healthcheck.intervalSeconds ?? 5,
          timeoutSeconds: service.healthcheck.timeoutSeconds ?? 3,
          retries: service.healthcheck.retries ?? 6,
          startPeriodSeconds: service.healthcheck.startPeriodSeconds ?? 10,
        }
      : undefined,
    replicas: service.replicas,
    runtimePort: service.runtimePort,
    updateParallelism: 1,
    updateDelaySeconds: 10,
    updateMonitorSeconds: 30,
    updateOrder: "start-first",
    failureAction: "rollback",
    stopGracePeriodSeconds: 10,
  }
}

export async function deployPlannedComposeStack(
  agent: ComposeSwarmAgent,
  plan: PlannedComposeStack
): Promise<string[]> {
  await agent.swarmEnsureSingleNode({})
  const created: string[] = []
  try {
    for (const service of plan.services) {
      await agent.serviceCreate({ spec: plannedServiceToSpec(service) })
      created.push(service.name)
    }
    return created
  } catch (err) {
    for (const name of [...created].reverse()) {
      await agent.serviceRemove({ serviceName: name }).catch(() => undefined)
    }
    throw err
  }
}

export async function removeComposeSwarmServices(
  agent: Pick<ComposeSwarmAgent, "serviceRemove">,
  names: string[]
): Promise<void> {
  for (const name of [...names].reverse()) {
    await agent.serviceRemove({ serviceName: name }).catch(() => undefined)
  }
}
