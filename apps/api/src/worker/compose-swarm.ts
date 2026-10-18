// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import * as grpc from "@grpc/grpc-js"
import {
  ContainerHealthStatus,
  type AgentClient,
} from "@ploydok/agent-proto"
import {
  composeToContainers,
  type ComposeContainer,
  type ComposeDependencyCondition,
} from "../marketplace/compose-to-containers.js"

/** Maximum wait for each dependency edge, in milliseconds. */
export const DEFAULT_DEPENDENCY_WAIT_TIMEOUT_MS = 300_000
const DEFAULT_DEPENDENCY_POLL_MS = 500
const DEFAULT_AGENT_RPC_TIMEOUT_MS = 30_000
const DEFAULT_AGENT_PROBE_TIMEOUT_MS = 5_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function grpcUnary<Res>(
  fn: (...args: any[]) => grpc.ClientUnaryCall,
  req: unknown,
  timeoutMs = DEFAULT_AGENT_RPC_TIMEOUT_MS
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    fn(
      req,
      new grpc.Metadata(),
      { deadline: new Date(Date.now() + Math.max(1, timeoutMs)) },
      (err: grpc.ServiceError | null, res: Res) => {
        if (err) reject(err)
        else resolve(res)
      }
    )
  })
}

export function swarmAgentFromGrpc(client: AgentClient): ComposeSwarmAgent {
  return {
    swarmEnsureSingleNode: (req) =>
      grpcUnary(client.swarmEnsureSingleNode.bind(client), req),
    serviceCreate: (req) => grpcUnary(client.serviceCreate.bind(client), req, 330_000),
    serviceRemove: (req) => grpcUnary(client.serviceRemove.bind(client), req),
    listServiceTasks: (req, timeoutMs) =>
      grpcUnary(client.listServiceTasks.bind(client), req, timeoutMs),
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
  composeName: string
  image: string
  env: Record<string, string>
  labels: Record<string, string>
  networks: string[]
  mounts: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>
  user?: string
  command: string[]
  restartPolicy: ComposeContainer["restartPolicy"]
  dependsOn: string[]
  dependsOnConditions?: Record<string, ComposeDependencyCondition>
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
    runtime: "swarm",
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
      composeName: container.composeName ?? "web",
      image: container.image,
      env: { ...container.env, ...input.extraEnv },
      labels: {
        ...container.labels,
        ...input.labels,
        "ploydok.runtime": "swarm",
        "ploydok.volume_root": container.labels["ploydok.volume_root"]!,
      },
      networks: [input.network],
      mounts: container.volumes.map((volume) => ({
        hostPath: volume.hostPath,
        containerPath: volume.containerPath,
        readOnly: volume.readOnly,
      })),
      ...(container.user !== undefined ? { user: container.user } : {}),
      command: container.command,
      restartPolicy: container.restartPolicy,
      dependsOn: container.dependsOn,
      ...(container.dependsOnConditions
        ? { dependsOnConditions: container.dependsOnConditions }
        : {}),
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
  listServiceTasks?: (req: { serviceName: string }, timeoutMs?: number) => Promise<{
    tasks: Array<{
      status: string
      running?: boolean
      exitCode?: number | undefined
      healthStatus?: string | undefined
      state?: string | undefined
    }>
  }>
}

export type DockerDependencyAgent = {
  inspectContainerHealth?: (
    req: { containerId: string },
    timeoutMs?: number
  ) => Promise<{
    status: number | string
    containerMissing: boolean
    running?: boolean | undefined
    exitCode?: number | undefined
    state?: string | undefined
  }>
}

export class DependencyWaitError extends Error {
  readonly condition: ComposeDependencyCondition
  readonly dependency: string
  readonly timedOut: boolean

  constructor(input: {
    dependency: string
    condition: ComposeDependencyCondition
    message: string
    timedOut?: boolean
  }) {
    super(input.message)
    this.name = "DependencyWaitError"
    this.dependency = input.dependency
    this.condition = input.condition
    this.timedOut = input.timedOut ?? false
  }
}

function dependencyProbeError(
  dependency: string,
  condition: ComposeDependencyCondition,
  action: string,
  error: unknown
): DependencyWaitError {
  if (error instanceof DependencyWaitError) return error
  const detail = error instanceof Error ? error.message : String(error)
  const wrapped = new DependencyWaitError({
    dependency,
    condition,
    message: `Failed to ${action} for dependency ${dependency}: ${detail}`,
  })
  ;(wrapped as Error & { cause?: unknown }).cause = error
  return wrapped
}

function conditionSatisfied(
  condition: ComposeDependencyCondition,
  status: string
): boolean {
  const normalized = status.toLowerCase()
  const running =
    normalized.includes("running") ||
    normalized.includes("up ") ||
    normalized === "up"
  if (condition === "service_started") return running && !normalized.includes("exited")
  if (condition === "service_healthy") {
    return running && normalized.includes("healthy") && !normalized.includes("unhealthy")
  }
  return false
}

function dockerHealthStatusIs(
  status: number | string,
  expected: ContainerHealthStatus
): boolean {
  if (status === expected) return true
  const normalized = String(status).toLowerCase()
  const name = ContainerHealthStatus[expected].toLowerCase()
  return normalized === name || normalized === name.replace("container_health_status_", "")
}

export async function waitForSwarmServiceCondition(
  agent: Pick<ComposeSwarmAgent, "listServiceTasks">,
  input: {
    serviceName: string
    condition: ComposeDependencyCondition
    replicas?: number
    restartPolicy?: ComposeContainer["restartPolicy"]
    timeoutMs?: number
    pollMs?: number
    onPoll?: () => void | Promise<void>
  }
): Promise<void> {
  if (!agent.listServiceTasks) {
    throw new DependencyWaitError({
      dependency: input.serviceName,
      condition: input.condition,
      message: `Cannot wait for Swarm dependency ${input.serviceName}: the agent does not support task inspection`,
    })
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_DEPENDENCY_WAIT_TIMEOUT_MS
  const pollMs = input.pollMs ?? DEFAULT_DEPENDENCY_POLL_MS
  const deadline = Date.now() + timeoutMs
  let lastTasks: Array<{
    status: string
    running?: boolean
    exitCode?: number | undefined
    healthStatus?: string | undefined
    state?: string | undefined
  }> = []
  const requiredReplicas = Math.max(1, input.replicas ?? 1)
  while (Date.now() < deadline) {
    await input.onPoll?.()
    const remaining = Math.max(1, deadline - Date.now())
    let result: Awaited<ReturnType<NonNullable<typeof agent.listServiceTasks>>>
    try {
      result = await agent.listServiceTasks(
        { serviceName: input.serviceName },
        Math.min(DEFAULT_AGENT_PROBE_TIMEOUT_MS, remaining)
      )
    } catch (error) {
      throw dependencyProbeError(
        input.serviceName,
        input.condition,
        "inspect Swarm tasks",
        error
      )
    }
    lastTasks = result.tasks
    await input.onPoll?.()
    const failedTasks = result.tasks.filter(
      (task) =>
        task.state === "exited" &&
        task.running === false &&
        task.exitCode !== undefined &&
        task.exitCode !== -1 &&
        task.exitCode !== 0
    )
    const satisfied = result.tasks.filter((task) => {
      if (input.condition === "service_completed_successfully") {
        return task.state === "exited" && task.running === false && task.exitCode === 0
      }
      if (input.condition === "service_healthy" && task.healthStatus !== undefined) {
        return task.running === true && task.healthStatus === "healthy"
      }
      if (input.condition === "service_started" && task.running !== undefined) {
        return task.running === true
      }
      return conditionSatisfied(input.condition, task.status)
    }).length
    if (
      result.tasks.length >= requiredReplicas &&
      failedTasks.length === result.tasks.length &&
      input.restartPolicy === "no"
    ) {
      throw new DependencyWaitError({
        dependency: input.serviceName,
        condition: input.condition,
        message:
          `Swarm dependency ${input.serviceName} exited with non-zero status ` +
          `before satisfying ${input.condition}; ` +
          `latest tasks: ${JSON.stringify(result.tasks)}`,
      })
    }
    if (
      satisfied >= requiredReplicas &&
      (input.condition !== "service_completed_successfully" ||
        satisfied === result.tasks.length)
    ) {
      return
    }
    const sleepMs = Math.min(pollMs, Math.max(1, deadline - Date.now()))
    await new Promise((resolve) => setTimeout(resolve, sleepMs))
  }
  throw new DependencyWaitError({
    dependency: input.serviceName,
    condition: input.condition,
    timedOut: true,
    message:
      `Timed out after ${timeoutMs}ms (per dependency edge) waiting for Swarm dependency ` +
      `${input.serviceName} to satisfy ${input.condition}; ` +
      `last tasks: ${JSON.stringify(lastTasks)}`,
  })
}

export async function waitForDockerContainerCondition(
  agent: DockerDependencyAgent,
  input: {
    containerId: string
    dependency: string
    condition: ComposeDependencyCondition
    restartPolicy?: ComposeContainer["restartPolicy"]
    timeoutMs?: number
    pollMs?: number
    onPoll?: () => void | Promise<void>
  }
): Promise<void> {
  if (!agent.inspectContainerHealth) {
    throw new DependencyWaitError({
      dependency: input.dependency,
      condition: input.condition,
      message: `Cannot wait for Docker dependency ${input.dependency}: the agent does not support container inspection`,
    })
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_DEPENDENCY_WAIT_TIMEOUT_MS
  const pollMs = input.pollMs ?? DEFAULT_DEPENDENCY_POLL_MS
  const deadline = Date.now() + timeoutMs
  let lastStatus: unknown = null
  while (Date.now() < deadline) {
    await input.onPoll?.()
    const remaining = Math.max(1, deadline - Date.now())
    let result: Awaited<ReturnType<NonNullable<typeof agent.inspectContainerHealth>>>
    try {
      result = await agent.inspectContainerHealth(
        { containerId: input.containerId },
        Math.min(DEFAULT_AGENT_PROBE_TIMEOUT_MS, remaining)
      )
    } catch (error) {
      throw dependencyProbeError(
        input.dependency,
        input.condition,
        "inspect Docker container",
        error
      )
    }
    lastStatus = result
    await input.onPoll?.()
    if (result.containerMissing) {
      throw new DependencyWaitError({
        dependency: input.dependency,
        condition: input.condition,
        message: `Docker dependency ${input.dependency} disappeared while waiting for ${input.condition}`,
      })
    }
    if (input.condition === "service_started" && result.running === true) return
    if (
      input.condition === "service_healthy" &&
      result.running === true &&
      dockerHealthStatusIs(result.status, ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY)
    ) {
      return
    }
    if (
      input.condition === "service_completed_successfully" &&
      result.state === "exited" &&
      result.running === false &&
      result.exitCode === 0
    ) {
      return
    }
    if (
      result.state === "exited" &&
      result.running === false &&
      result.exitCode !== undefined &&
      result.exitCode !== 0 &&
      result.exitCode !== -1 &&
      input.restartPolicy === "no"
    ) {
      throw new DependencyWaitError({
        dependency: input.dependency,
        condition: input.condition,
        message:
          `Docker dependency ${input.dependency} exited with code ` +
          `${result.exitCode} before satisfying ${input.condition}`,
      })
    }
    const sleepMs = Math.min(pollMs, Math.max(1, deadline - Date.now()))
    await new Promise((resolve) => setTimeout(resolve, sleepMs))
  }
  throw new DependencyWaitError({
    dependency: input.dependency,
    condition: input.condition,
    timedOut: true,
    message:
      `Timed out after ${timeoutMs}ms (per dependency edge) waiting for Docker dependency ` +
      `${input.dependency} to satisfy ${input.condition}; ` +
      `last state: ${JSON.stringify(lastStatus)}`,
  })
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
    user: service.user ?? "",
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
    restartCondition:
      service.restartPolicy === "no"
        ? "none"
        : service.restartPolicy === "on-failure"
          ? "on-failure"
          : "any",
  }
}

export async function deployPlannedComposeStack(
  agent: ComposeSwarmAgent,
  plan: PlannedComposeStack,
  options?: {
    onPoll?: () => void | Promise<void>
  }
): Promise<string[]> {
  let leaseCallbackFailed = false
  const renewLease = async () => {
    try {
      await options?.onPoll?.()
    } catch (error) {
      leaseCallbackFailed = true
      throw error
    }
  }
  await renewLease()
  await agent.swarmEnsureSingleNode({})
  const created: string[] = []
  try {
    for (const service of plan.services) {
      await renewLease()
      for (const dependency of service.dependsOn) {
        const condition =
          service.dependsOnConditions?.[dependency] ?? "service_started"
        const dependencyService = plan.services.find(
          (candidate) => candidate.composeName === dependency
        )
        if (!dependencyService) {
          throw new DependencyWaitError({
            dependency,
            condition,
            message: `Swarm dependency ${dependency} is not present in the deployment plan`,
          })
        }
        await waitForSwarmServiceCondition(agent, {
          serviceName: dependencyService.name,
          condition,
          replicas: dependencyService.replicas,
          restartPolicy: dependencyService.restartPolicy,
          onPoll: renewLease,
        })
      }
      await renewLease()
      await agent.serviceCreate({ spec: plannedServiceToSpec(service) })
      created.push(service.name)
    }
    return created
  } catch (err) {
    // A failed fence leaves ownership uncertain. A successor may already own
    // these service names, so the stale worker must not remove them.
    if (!leaseCallbackFailed) {
      for (const name of [...created].reverse()) {
        await agent.serviceRemove({ serviceName: name }).catch(() => undefined)
      }
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
