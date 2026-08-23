// SPDX-License-Identifier: AGPL-3.0-only
import { parse } from "yaml"

export interface ComposeToContainersInput {
  compose: string
  servicePrefix: string
  network: string
  labels?: Record<string, string>
}

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
  }>
  restartPolicy: "no" | "always" | "unless-stopped" | "on-failure"
  command: string[]
  dependsOn: string[]
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
  constructor(message: string) {
    super(message)
    this.name = "UnsupportedComposeFeatureError"
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
  servicePrefix: string,
  namedVolumes: Set<string>
): Array<{ hostPath: string; containerPath: string; readOnly: boolean }> {
  if (!raw || !Array.isArray(raw)) return []
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
      const mode = parts[2]
      const readOnly = mode === "ro"
      const hostPath = resolveHostPath(
        src,
        servicePrefix,
        namedVolumes,
        serviceName
      )
      result.push({ hostPath, containerPath: dst, readOnly })
    } else if (typeof item === "object" && item !== null) {
      const v = item as Record<string, unknown>
      const src = String(v.source ?? "")
      const dst = String(v.target ?? "")
      const readOnly = v.read_only === true
      const hostPath = resolveHostPath(
        src,
        servicePrefix,
        namedVolumes,
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
  namedVolumes: Set<string>,
  serviceName: string
): string {
  if (src.startsWith("/")) {
    if (!src.startsWith(PLOYDOK_VOLUMES_ROOT)) {
      throw new UnsupportedComposeFeatureError(
        `Service "${serviceName}": absolute host volume path "${src}" is not allowed. ` +
          `Only paths under ${PLOYDOK_VOLUMES_ROOT} are permitted.`
      )
    }
    return src
  }
  // Named volume (no path separator at start) or relative path
  if (
    namedVolumes.has(src) ||
    (!src.startsWith(".") && !src.startsWith("~") && !src.includes("/"))
  ) {
    return `${PLOYDOK_VOLUMES_ROOT}/${servicePrefix}/${src}`
  }
  // Relative path: strip leading ./
  const relative = src.replace(/^\.\//, "")
  return `${PLOYDOK_VOLUMES_ROOT}/${servicePrefix}/${relative}`
}

function parsePorts(
  raw: unknown,
  serviceName: string
): Array<{ containerPort: number; hostPort: number; proto: "tcp" | "udp" }> {
  if (!raw || !Array.isArray(raw)) return []
  const result: Array<{
    containerPort: number
    hostPort: number
    proto: "tcp" | "udp"
  }> = []

  for (const item of raw) {
    if (typeof item === "number") {
      result.push({ containerPort: item, hostPort: item, proto: "tcp" })
      continue
    }
    if (typeof item === "string") {
      // Strip optional IP binding: "127.0.0.1:5432:5432" or "5432:5432" or "5432:5432/udp"
      let spec = item
      let proto: "tcp" | "udp" = "tcp"
      if (spec.includes("/")) {
        const slashParts = spec.split("/")
        spec = slashParts[0] ?? spec
        proto = slashParts[1] === "udp" ? "udp" : "tcp"
      }
      const parts = spec.split(":")
      // parts may be [ip, hostPort, containerPort] or [hostPort, containerPort] or [containerPort]
      let hostPort: number
      let containerPort: number
      if (parts.length === 3) {
        // IP:host:container
        hostPort = parseInt(parts[1] ?? "", 10)
        containerPort = parseInt(parts[2] ?? "", 10)
      } else if (parts.length === 2) {
        hostPort = parseInt(parts[0] ?? "", 10)
        containerPort = parseInt(parts[1] ?? "", 10)
      } else {
        containerPort = parseInt(parts[0] ?? "", 10)
        hostPort = containerPort
      }
      if (isNaN(containerPort) || isNaN(hostPort)) {
        throw new UnsupportedComposeFeatureError(
          `Service "${serviceName}": invalid port mapping "${item}"`
        )
      }
      result.push({ containerPort, hostPort, proto })
    } else if (typeof item === "object" && item !== null) {
      const p = item as Record<string, unknown>
      result.push({
        containerPort: Number(p.target ?? 0),
        hostPort: Number(p.published ?? p.target ?? 0),
        proto: p.protocol === "udp" ? "udp" : "tcp",
      })
    }
  }

  return result
}

function parseCommand(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === "string") {
    // Simple space-split — does not handle quoted strings
    return raw.trim().split(/\s+/)
  }
  return []
}

function parseDependsOn(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === "object" && raw !== null) {
    // Map form: { "db": { condition: "service_healthy" } } — keep keys only
    return Object.keys(raw as Record<string, unknown>)
  }
  return []
}

function parseHealthcheck(
  raw: unknown
): ComposeContainer["healthcheck"] | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const h = raw as Record<string, unknown>

  const testRaw = h.test
  let test: string[] = []
  if (Array.isArray(testRaw)) {
    test = testRaw.map(String)
  } else if (typeof testRaw === "string") {
    test = ["CMD-SHELL", testRaw]
  }

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

function parseRestartPolicy(raw: unknown): ComposeContainer["restartPolicy"] {
  const valid = ["no", "always", "unless-stopped", "on-failure"] as const
  if (typeof raw === "string" && (valid as readonly string[]).includes(raw)) {
    return raw as ComposeContainer["restartPolicy"]
  }
  return "unless-stopped"
}

// Topological sort — returns service names in dependency order, throws on cycle
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

  // Collect top-level named volumes
  const namedVolumes = new Set<string>()
  if (doc.volumes && typeof doc.volumes === "object") {
    for (const key of Object.keys(doc.volumes as Record<string, unknown>)) {
      namedVolumes.add(key)
    }
  }

  // First pass: parse each service into intermediate shape
  const parsed: Record<string, ComposeContainer & { _composeName: string }> = {}

  for (const [svcName, svcRaw] of Object.entries(services)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = svcRaw as any

    assertNoUnsupportedServiceFeatures(svcName, svc)

    if (!svc.image) {
      throw new Error(`Service "${svcName}": "image" is required`)
    }

    const env = parseEnv(svc.environment, svcName)
    const userLabels = parseLabels(svc.labels)
    const mergedLabels = { ...userLabels, ...extraLabels }
    const volumes = parseVolumes(
      svc.volumes,
      svcName,
      servicePrefix,
      namedVolumes
    )
    const ports = parsePorts(svc.ports, svcName)
    const command = parseCommand(svc.command)
    const dependsOn = parseDependsOn(svc.depends_on)
    const restartPolicy = parseRestartPolicy(svc.restart)
    const healthcheck = parseHealthcheck(svc.healthcheck)
    const containerName = `${servicePrefix}-${svcName}`
    const exposedPort = ports[0]?.containerPort

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
      dependsOn,
    }
    if (healthcheck !== undefined) entry.healthcheck = healthcheck
    if (exposedPort !== undefined) entry.exposedPort = exposedPort
    parsed[svcName] = entry
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
