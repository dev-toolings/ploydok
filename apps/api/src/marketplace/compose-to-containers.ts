// SPDX-License-Identifier: AGPL-3.0-only
import { posix } from "node:path"
import { parse } from "yaml"
import { isIP } from "node:net"
import { createHash } from "node:crypto"
import { normalizeRuntimeContainerSlug } from "../services/runtime-containers"

export function composeContainerName(servicePrefix: string, serviceName: string): string {
  const raw = `${servicePrefix}-${serviceName}`
  if (/^ploydok-[a-z0-9][a-z0-9-]{0,62}$/.test(raw)) return raw
  // Preserve distinct IDs and service keys that normalize to the same token.
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 10)
  const token = normalizeRuntimeContainerSlug(raw, 60).replace(/-+$/, "")
  return `${token}-${hash}`
}

export interface ComposeToContainersInput {
  compose: string
  runtime?: "swarm" | "docker"
  servicePrefix: string
  network: string
  labels?: Record<string, string>
}

export type ComposeDependencyCondition =
  | "service_started"
  | "service_healthy"
  | "service_completed_successfully"

export interface ComposeContainer {
  name: string
  image: string
  env: Record<string, string>
  labels: Record<string, string>
  networks: string[]
  volumes: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>
  ports: Array<{
    containerPort: number
    hostPort: number
    proto: "tcp" | "udp"
    hostIp?: string
  }>
  restartPolicy: "no" | "always" | "unless-stopped" | "on-failure"
  command: string[]
  user?: string
  dependsOn: string[]
  /** Conditions are keyed by the Compose service named in dependsOn. */
  dependsOnConditions?: Record<string, ComposeDependencyCondition>
  composeName?: string
  healthcheck?: {
    test: string[]
    intervalSeconds?: number
    timeoutSeconds?: number
    retries?: number
    startPeriodSeconds?: number
  }
  exposedPort?: number
}

export class UnsupportedComposeFeatureError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor(message: string) {
    super(message)
    this.name = "UnsupportedComposeFeatureError"
  }
}

const SWARM_RESTART_EQUIVALENT = ["always", "unless-stopped"]

export const ACCEPTED_COMPOSE_SUBSET = Object.freeze({
  topLevel: ["services", "volumes", "version"],
  service: ["image", "environment", "labels", "volumes", "command", "user", "healthcheck", "expose"],
  // Swarm: ports are internal only (never published on the host, ingress is
  // Caddy); an explicit host IP selects the Docker runtime. Restart is
  // always/unless-stopped except one-shot completion dependencies.
  // depends_on conditions are preserved for the orchestration wait step.
  legacyOnly: ["ports", "restart", "depends_on"],
  healthcheck: ["test", "interval", "timeout", "retries", "start_period"],
})
// x-* extension metadata is permitted but never affects runtime behavior.
function assertFields(raw: Record<string, unknown>, allowed: readonly string[], context: string) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key) && !key.startsWith("x-")) {
      throw new UnsupportedComposeFeatureError(`${context}: "${key}" is not supported; refusing before resource creation`)
    }
  }
}

const PLOYDOK_VOLUMES_ROOT = "/var/lib/ploydok/volumes"

function parseDuration(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const s = String(value)
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
  if (!m) return undefined
  const n = parseFloat(m[1] ?? "0")
  const unit = m[2] ?? "s"
  switch (unit) {
    case "ms":
      return Math.round(n / 1000)
    case "s":
      return Math.round(n)
    case "m":
      return Math.round(n * 60)
    case "h":
      return Math.round(n * 3600)
    default:
      return Math.round(n)
  }
}

function parseEnv(raw: unknown, serviceName: string): Record<string, string> {
  if (!raw) return {}
  if (Array.isArray(raw)) {
    const result: Record<string, string> = {}
    for (const item of raw) {
      if (typeof item !== "string") throw new UnsupportedComposeFeatureError("environment entries must be strings")
      const idx = item.indexOf("=")
      if (idx === -1) {
        throw new UnsupportedComposeFeatureError("environment inheritance is not supported; provide KEY=value")
      } else {
        result[item.slice(0, idx)] = item.slice(idx + 1)
      }
    }
    return result
  }
  if (typeof raw === "object" && raw !== null) {
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || v === undefined) throw new UnsupportedComposeFeatureError("environment inheritance is not supported; provide explicit values")
      result[k] = String(v)
    }
    return result
  }
  throw new UnsupportedComposeFeatureError(
    `Service "${serviceName}": environment must be a map or array`
  )
}

function parseLabels(raw: unknown): Record<string, string> {
  if (!raw) return {}
  if (Array.isArray(raw)) {
    const result: Record<string, string> = {}
    for (const item of raw) {
      if (typeof item !== "string") continue
      const idx = item.indexOf("=")
      if (idx === -1) {
        result[item] = ""
      } else {
        result[item.slice(0, idx)] = item.slice(idx + 1)
      }
    }
    return result
  }
  if (typeof raw === "object" && raw !== null) {
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      result[k] = v === null || v === undefined ? "" : String(v)
    }
    return result
  }
  return {}
}

function parseVolumes(
  raw: unknown,
  serviceName: string,
  servicePrefix: string
): Array<{ hostPath: string; containerPath: string; readOnly: boolean }> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new UnsupportedComposeFeatureError(`Service "${serviceName}": volumes must be a list`)
  const result: Array<{
    hostPath: string
    containerPath: string
    readOnly: boolean
  }> = []

  for (const item of raw) {
    if (typeof item === "string") {
      const parts = item.split(":")
      if (parts.length < 2) {
        throw new UnsupportedComposeFeatureError(
          `Service "${serviceName}": invalid volume spec "${item}"`
        )
      }
      const src = parts[0] ?? ""
      const dst = parts[1] ?? ""
      if (parts.length > 3 || (parts[2] !== undefined && !["ro", "rw"].includes(parts[2]))) throw new UnsupportedComposeFeatureError(`Service "${serviceName}": unsupported volume options`)
      const mode = parts[2]
      const readOnly = mode === "ro"
      const hostPath = resolveHostPath(
        src,
        servicePrefix,
        serviceName
      )
      result.push({ hostPath, containerPath: dst, readOnly })
    } else if (typeof item === "object" && item !== null) {
      const v = item as Record<string, unknown>
      assertFields(v, ["source", "target", "read_only", "type"], `Service "${serviceName}" volume`)
      if (v.type !== undefined && !["bind", "volume"].includes(String(v.type))) throw new UnsupportedComposeFeatureError("Unsupported volume type")
      const src = String(v.source ?? "")
      const dst = String(v.target ?? "")
      const readOnly = v.read_only === true
      const hostPath = resolveHostPath(
        src,
        servicePrefix,
        serviceName
      )
      result.push({ hostPath, containerPath: dst, readOnly })
    }
  }

  return result
}

function resolveHostPath(
  src: string,
  servicePrefix: string,
  serviceName: string
): string {
  const serviceRoot = posix.join(PLOYDOK_VOLUMES_ROOT, servicePrefix)
  if (src.startsWith("/")) {
    const normalized = posix.normalize(src).replace(/\/+$/, "") || "/"
    if (normalized === serviceRoot || !normalized.startsWith(`${serviceRoot}/`)) {
      throw new UnsupportedComposeFeatureError(
        `Service "${serviceName}": volume source "${src}" escapes the service volume directory`
      )
    }
    return normalized
  }
  // Named volumes and relative binds share the service storage boundary.
  const normalized = posix.resolve(serviceRoot, src)
  if (!normalized.startsWith(`${serviceRoot}/`)) {
    throw new UnsupportedComposeFeatureError(
      `Service "${serviceName}": volume source "${src}" escapes the service volume directory`
    )
  }
  return normalized
}

function validateHostIp(hostIp: string, serviceName: string): string {
  if (isIP(hostIp) === 0) {
    throw new UnsupportedComposeFeatureError(
      `Service "${serviceName}": host IP "${hostIp}" must be an IPv4 or IPv6 literal`
    )
  }
  if (hostIp === "0.0.0.0" || hostIp === "::") {
    throw new UnsupportedComposeFeatureError(
      `Service "${serviceName}": wildcard host IP "${hostIp}" is forbidden; bind to an explicit interface`
    )
  }
  return hostIp
}

function parsePortNumber(value: unknown, serviceName: string, field: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UnsupportedComposeFeatureError(
      `Service "${serviceName}": ${field} must be an integer between 1 and 65535`
    )
  }
  return port
}

function parsePorts(
  raw: unknown,
  serviceName: string
): Array<{ containerPort: number; hostPort: number; proto: "tcp" | "udp"; hostIp?: string }> {
  if (!raw || !Array.isArray(raw)) return []
  const result: Array<{
    containerPort: number
    hostPort: number
    proto: "tcp" | "udp"
    hostIp?: string
  }> = []

  for (const item of raw) {
    if (typeof item === "number") {
      const port = parsePortNumber(item, serviceName, "port")
      result.push({ containerPort: port, hostPort: port, proto: "tcp" })
      continue
    }
    if (typeof item === "string") {
      let spec = item
      let proto: "tcp" | "udp" = "tcp"
      if (spec.includes("/")) {
        const slashParts = spec.split("/")
        spec = slashParts[0] ?? spec
        proto = slashParts[1] === "udp" ? "udp" : "tcp"
      }
      let hostIp: string | undefined
      let portSpec = spec
      if (spec.startsWith("[")) {
        const end = spec.indexOf("]")
        if (end < 0) {
          throw new UnsupportedComposeFeatureError(
            `Service "${serviceName}": invalid IPv6 port mapping "${item}"`
          )
        }
        hostIp = validateHostIp(spec.slice(1, end), serviceName)
        portSpec = spec.slice(end + 1).replace(/^:/, "")
      }
      const parts = portSpec.split(":")
      if (!hostIp && parts.length === 3) {
        hostIp = validateHostIp(parts[0] ?? "", serviceName)
        portSpec = parts.slice(1).join(":")
      } else if (!hostIp && parts.length > 3) {
        hostIp = validateHostIp(parts.slice(0, -2).join(":"), serviceName)
        portSpec = parts.slice(-2).join(":")
      }
      const portParts = portSpec.split(":")
      let hostPort: number
      let containerPort: number
      if (portParts.length === 2) {
        hostPort = parsePortNumber(portParts[0], serviceName, "published port")
        containerPort = parsePortNumber(portParts[1], serviceName, "target port")
      } else {
        if (portParts.length !== 1) {
          throw new UnsupportedComposeFeatureError(
            `Service "${serviceName}": invalid port mapping "${item}"`
          )
        }
        containerPort = parsePortNumber(portParts[0], serviceName, "target port")
        hostPort = containerPort
      }
      result.push({ containerPort, hostPort, proto, ...(hostIp ? { hostIp } : {}) })
    } else if (typeof item === "object" && item !== null) {
      const p = item as Record<string, unknown>
      assertFields(p, ["target", "published", "protocol", "host_ip"], `Service "${serviceName}" port`)
      const hostIp =
        p.host_ip === undefined || p.host_ip === null || p.host_ip === ""
          ? undefined
          : validateHostIp(String(p.host_ip), serviceName)
      const containerPort = parsePortNumber(p.target, serviceName, "target port")
      const hostPort = parsePortNumber(
        p.published ?? p.target,
        serviceName,
        "published port"
      )
      result.push({
        containerPort,
        hostPort,
        proto: p.protocol === "udp" ? "udp" : "tcp",
        ...(hostIp ? { hostIp } : {}),
      })
    }
  }

  return result
}

function parseCommand(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return []
  if (Array.isArray(raw) && raw.every(value => typeof value === "string")) return raw
  if (typeof raw !== "string") throw new UnsupportedComposeFeatureError("command must be a string or string list")
  const args: string[] = []
  let value = "", quote = "", started = false
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    if (char === "\\" && quote !== "'") {
      const next = raw[++i]
      if (next === undefined) throw new UnsupportedComposeFeatureError("command has an unfinished escape")
      // Within double quotes only shell-special characters lose their backslash.
      value += quote === '"' && !['$', '`', '"', "\\", "\n"].includes(next) ? "\\" + next : next
      started = true
    } else if (quote) {
      if (char === quote) quote = ""
      else value += char
    } else if (char === '"' || char === "'") {
      quote = char; started = true
    } else if (/\s/.test(char)) {
      if (started) { args.push(value); value = ""; started = false }
    } else { value += char; started = true }
  }
  if (quote) throw new UnsupportedComposeFeatureError("command has an unterminated quote")
  if (started) args.push(value)
  return args
}

/**
 * Swarm services never publish host ports here (ingress goes through Caddy)
 * and ordinary services restart under the default "any" condition. One-shot
 * services used by service_completed_successfully are validated separately.
 * Accept only what keeps its meaning under those rules, and refuse the rest
 * before any resource exists.
 */
function assertSwarmCompatible(
  svcName: string,
  svc: Record<string, unknown>,
  allowsOneShotRestart: boolean
) {
  if (svc.command === "" || (Array.isArray(svc.command) && svc.command.length === 0))
    throw new UnsupportedComposeFeatureError("Empty command override cannot be preserved by the Swarm contract")
  // Swarm cannot bind a published port to a host IP. Marketplace selection
  // routes such a Compose file to Docker before this validator is called.
  const ports = parsePorts(svc.ports, svcName)
  if (ports.some((port) => port.hostIp)) {
    throw new UnsupportedComposeFeatureError(
      `Service "${svcName}": address-specific port publication cannot be preserved in Swarm`
    )
  }
  if (
    svc.restart !== undefined &&
    !SWARM_RESTART_EQUIVALENT.includes(String(svc.restart)) &&
    !(allowsOneShotRestart && ["no", "on-failure"].includes(String(svc.restart)))
  ) {
    throw new UnsupportedComposeFeatureError(
      `Service "${svcName}": restart "${String(svc.restart)}" cannot be preserved by Swarm's restart policy; use always or unless-stopped, or no/on-failure for service_completed_successfully`
    )
  }
}

function parseDependsOn(raw: unknown): {
  names: string[]
  conditions: Record<string, ComposeDependencyCondition>
} {
  if (!raw) return { names: [], conditions: {} }
  if (Array.isArray(raw)) {
    const names = raw.map(String)
    return {
      names,
      conditions: Object.fromEntries(
        names.map((name) => [name, "service_started"])
      ) as Record<string, ComposeDependencyCondition>,
    }
  }
  if (typeof raw === "object" && raw !== null) {
    const names: string[] = []
    const conditions: Record<string, ComposeDependencyCondition> = {}
    for (const [dep, spec] of Object.entries(raw as Record<string, unknown>)) {
      let condition: unknown = "service_started"
      if (spec && typeof spec === "object" && !Array.isArray(spec)) {
        const depSpec = spec as Record<string, unknown>
        assertFields(depSpec, ["condition"], `depends_on ${dep}`)
        condition = depSpec.condition ?? "service_started"
      }
      if (
        condition !== "service_started" &&
        condition !== "service_healthy" &&
        condition !== "service_completed_successfully"
      ) {
        throw new UnsupportedComposeFeatureError(
          `depends_on ${dep} condition "${String(condition)}" is not supported; expected service_started, service_healthy or service_completed_successfully`
        )
      }
      names.push(dep)
      conditions[dep] = condition
    }
    return { names, conditions }
  }
  return { names: [], conditions: {} }
}

function parseHealthcheck(
  raw: unknown
): ComposeContainer["healthcheck"] | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UnsupportedComposeFeatureError("healthcheck must be a map")
  const h = raw as Record<string, unknown>
  assertFields(h, ACCEPTED_COMPOSE_SUBSET.healthcheck, "healthcheck")

  const testRaw = h.test
  let test: string[] = []
  if (Array.isArray(testRaw)) {
    test = testRaw.map(String)
  } else if (typeof testRaw === "string") {
    test = ["CMD-SHELL", testRaw]
  }

  if (!test.length || !["CMD", "CMD-SHELL", "NONE"].includes(test[0]!)) throw new UnsupportedComposeFeatureError("healthcheck requires a CMD, CMD-SHELL or NONE test")
  for (const field of ["interval", "timeout", "start_period"]) {
    if (h[field] !== undefined && (!/^\d+(s|m|h)?$/.test(String(h[field])) || parseDuration(h[field]) === undefined))
      throw new UnsupportedComposeFeatureError(`healthcheck ${field} requires whole-second precision`)
  }
  if (h.retries !== undefined && (!Number.isSafeInteger(h.retries) || Number(h.retries) < 0)) throw new UnsupportedComposeFeatureError("healthcheck retries must be a nonnegative integer")
  const hc: NonNullable<ComposeContainer["healthcheck"]> = { test }
  const interval = parseDuration(h.interval)
  const timeout = parseDuration(h.timeout)
  const startPeriod = parseDuration(h.start_period)
  if (interval !== undefined) hc.intervalSeconds = interval
  if (timeout !== undefined) hc.timeoutSeconds = timeout
  if (h.retries !== undefined) hc.retries = Number(h.retries)
  if (startPeriod !== undefined) hc.startPeriodSeconds = startPeriod
  return hc
}

function hasUsableHealthcheck(
  healthcheck: ComposeContainer["healthcheck"] | undefined
): boolean {
  if (!healthcheck || healthcheck.test[0] === "NONE") return false
  return healthcheck.test
    .slice(1)
    .some((part) => part.trim().length > 0)
}

function parseRestartPolicy(raw: unknown): ComposeContainer["restartPolicy"] {
  const valid = ["no", "always", "unless-stopped", "on-failure"] as const
  if (typeof raw === "string" && (valid as readonly string[]).includes(raw)) {
    return raw as ComposeContainer["restartPolicy"]
  }
  return "unless-stopped"
}

// Topological sort: returns service names in dependency order and throws on cycle
function topoSort(services: Record<string, { dependsOn: string[] }>): string[] {
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const result: string[] = []

  function visit(name: string, path: string[]) {
    if (inStack.has(name)) {
      throw new Error(
        `Cycle detected in depends_on: ${[...path, name].join(" → ")}`
      )
    }
    if (visited.has(name)) return
    inStack.add(name)
    for (const dep of services[name]?.dependsOn ?? []) {
      if (!(dep in services)) {
        throw new Error(`Service "${name}" depends on unknown service "${dep}"`)
      }
      visit(dep, [...path, name])
    }
    inStack.delete(name)
    visited.add(name)
    result.push(name)
  }

  for (const name of Object.keys(services)) {
    visit(name, [])
  }

  return result
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertNoUnsupportedTopLevel(doc: any) {
  const unsupported = ["configs", "secrets"] as const
  for (const key of unsupported) {
    if (doc[key] !== undefined) {
      throw new UnsupportedComposeFeatureError(
        `Top-level "${key}" is not supported in Ploydok marketplace composes`
      )
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertNoUnsupportedServiceFeatures(name: string, svc: any) {
  if (svc.build !== undefined) {
    throw new UnsupportedComposeFeatureError(
      `Service "${name}": "build" is not supported. Provide a pre-built image reference.`
    )
  }
  if (svc.env_file !== undefined) {
    throw new UnsupportedComposeFeatureError(
      `Service "${name}": "env_file" is not supported. Inline all variables in "environment".`
    )
  }
  if (svc.extends !== undefined) {
    throw new UnsupportedComposeFeatureError(
      `Service "${name}": "extends" is not supported.`
    )
  }
  if (svc.deploy !== undefined) {
    throw new UnsupportedComposeFeatureError(
      `Service "${name}": "deploy" (Swarm) is not supported.`
    )
  }
  if (svc.networks !== undefined) {
    throw new UnsupportedComposeFeatureError(
      `Service "${name}": per-service "networks" override is not supported. All services are joined to the provided network.`
    )
  }
  if (svc.privileged === true) {
    throw new UnsupportedComposeFeatureError(
      `Service "${name}": privileged containers are not supported.`
    )
  }
  if (
    typeof svc.network_mode === "string" &&
    (svc.network_mode === "host" || svc.network_mode === "service")
  ) {
    throw new UnsupportedComposeFeatureError(
      `Service "${name}": network_mode "${svc.network_mode}" is not supported.`
    )
  }
  if (svc.cap_add !== undefined) {
    throw new UnsupportedComposeFeatureError(
      `Service "${name}": cap_add is not supported.`
    )
  }
}

export function composeToContainers(
  input: ComposeToContainersInput
): ComposeContainer[] {
  const { compose, servicePrefix, network, labels: extraLabels = {} } = input

  let doc: Record<string, unknown>
  try {
    const parsed = parse(compose)
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Parsed compose is not an object")
    }
    doc = parsed as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid YAML: ${msg}`)
  }

  assertNoUnsupportedTopLevel(doc)
  assertFields(doc, ACCEPTED_COMPOSE_SUBSET.topLevel, "Compose")

  if (doc.include !== undefined) {
    throw new UnsupportedComposeFeatureError(
      '"include" is not supported in Ploydok marketplace composes'
    )
  }

  const rawServices = doc.services
  if (!rawServices || typeof rawServices !== "object") {
    throw new Error('Compose file must have a "services" key')
  }
  const services = rawServices as Record<string, unknown>

  // Validate top-level local volume declarations
  if (doc.volumes && typeof doc.volumes === "object") {
    for (const key of Object.keys(doc.volumes as Record<string, unknown>)) {
      const definition = (doc.volumes as Record<string, unknown>)[key]
      if (definition && Object.keys(definition as object).length) throw new UnsupportedComposeFeatureError(`Volume "${key}": driver/external/options definitions are not supported`)
    }
  }

  // First pass: parse each service into intermediate shape
  const parsed: Record<string, ComposeContainer & { _composeName: string }> = {}

  for (const [svcName, svcRaw] of Object.entries(services)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = svcRaw as any

    if (!svc || typeof svc !== "object" || Array.isArray(svc)) throw new UnsupportedComposeFeatureError(`Service "${svcName}" must be a map`)
    assertNoUnsupportedServiceFeatures(svcName, svc)
    assertFields(svc, [...ACCEPTED_COMPOSE_SUBSET.service, ...ACCEPTED_COMPOSE_SUBSET.legacyOnly], `Service "${svcName}"`)
    if (svc.user !== undefined && typeof svc.user !== "string" && typeof svc.user !== "number")
      throw new UnsupportedComposeFeatureError(`Service "${svcName}": user must be a string or numeric UID`)

    if (!svc.image) {
      throw new Error(`Service "${svcName}": "image" is required`)
    }

    const env = parseEnv(svc.environment, svcName)
    const userLabels = parseLabels(svc.labels)
    const mergedLabels = {
      ...userLabels,
      ...extraLabels,
      "ploydok.volume_root": posix.join(PLOYDOK_VOLUMES_ROOT, servicePrefix),
    }
    const volumes = parseVolumes(
      svc.volumes,
      svcName,
      servicePrefix
    )
    const ports = parsePorts(svc.ports, svcName)
    const command = parseCommand(svc.command)
    const dependsOn = parseDependsOn(svc.depends_on)
    const restartPolicy = parseRestartPolicy(svc.restart)
    const healthcheck = parseHealthcheck(svc.healthcheck)
    const containerName = composeContainerName(servicePrefix, svcName)
    if (svc.expose !== undefined && (!Array.isArray(svc.expose) || svc.expose.some((port: unknown) => !/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)))
      throw new UnsupportedComposeFeatureError(`Service "${svcName}": expose must contain valid TCP port numbers`)
    const exposedPort = svc.expose?.length ? Number(svc.expose[0]) : ports[0]?.containerPort

    const entry: ComposeContainer & { _composeName: string } = {
      _composeName: svcName,
      composeName: svcName,
      name: containerName,
      image: String(svc.image),
      env,
      labels: mergedLabels,
      networks: [network],
      volumes,
      ports,
      restartPolicy,
      command,
      ...(svc.user !== undefined ? { user: String(svc.user) } : {}),
      dependsOn: dependsOn.names,
      ...(dependsOn.names.length
        ? { dependsOnConditions: dependsOn.conditions }
        : {}),
    }
    if (healthcheck !== undefined) entry.healthcheck = healthcheck
    if (exposedPort !== undefined) entry.exposedPort = exposedPort
    parsed[svcName] = entry
  }

  const completedDependencyNames = new Set<string>()
  for (const [svcName, service] of Object.entries(parsed)) {
    for (const [dependencyName, condition] of Object.entries(
      service.dependsOnConditions ?? {}
    )) {
      const dependency = parsed[dependencyName]
      if (!dependency) continue
      if (
        condition === "service_healthy" &&
        !hasUsableHealthcheck(dependency.healthcheck)
      ) {
        throw new UnsupportedComposeFeatureError(
          `depends_on ${svcName}.${dependencyName} condition "service_healthy" requires dependency service "${dependencyName}" to define a usable healthcheck`
        )
      }
      if (condition === "service_completed_successfully") {
        completedDependencyNames.add(dependencyName)
        const dependencyRaw = services[dependencyName]
        if (
          dependencyRaw &&
          typeof dependencyRaw === "object" &&
          !Array.isArray(dependencyRaw) &&
          (dependencyRaw as Record<string, unknown>).restart === undefined
        ) {
          // Compose defaults completed jobs to a one-shot container.
          dependency.restartPolicy = "no"
        }
        if (!["no", "on-failure"].includes(dependency.restartPolicy)) {
          throw new UnsupportedComposeFeatureError(
            `depends_on ${svcName}.${dependencyName} condition "service_completed_successfully" requires dependency service "${dependencyName}" to use restart "no" or "on-failure"`
          )
        }
      }
    }
  }

  if (input.runtime === "swarm") {
    for (const [svcName, svcRaw] of Object.entries(services)) {
      assertSwarmCompatible(
        svcName,
        svcRaw as Record<string, unknown>,
        completedDependencyNames.has(svcName)
      )
    }
  }

  // Topological sort
  const depGraph: Record<string, { dependsOn: string[] }> = {}
  for (const [name, c] of Object.entries(parsed)) {
    depGraph[name] = { dependsOn: c.dependsOn }
  }
  const order = topoSort(depGraph)

  return order.map((name) => {
    const entry = parsed[name]!
    const { _composeName, ...rest } = entry
    return { ...rest, composeName: _composeName }
  })
}

/**
 * Return true when a Compose file explicitly asks Docker to publish a port
 * on one literal host IP. Unbound ports stay internal and therefore remain
 * eligible for the Swarm runtime.
 */
export function composeRequiresContainerRuntime(compose: string): boolean {
  let doc: Record<string, unknown>
  try {
    const parsed = parse(compose)
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Parsed compose is not an object")
    }
    doc = parsed as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid YAML: ${msg}`)
  }

  const rawServices = doc.services
  if (!rawServices || typeof rawServices !== "object") {
    throw new Error('Compose file must have a "services" key')
  }
  for (const [serviceName, rawService] of Object.entries(
    rawServices as Record<string, unknown>
  )) {
    if (!rawService || typeof rawService !== "object" || Array.isArray(rawService)) {
      throw new UnsupportedComposeFeatureError(`Service "${serviceName}" must be a map`)
    }
    if (parsePorts((rawService as Record<string, unknown>).ports, serviceName).some((port) => port.hostIp)) {
      return true
    }
  }
  return false
}
