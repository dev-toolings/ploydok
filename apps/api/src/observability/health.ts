// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm"
import { and, inArray, isNotNull, eq } from "drizzle-orm"
import { existsSync } from "node:fs"
import { apps, databases, services, type Db } from "@ploydok/db"
import type { IngressNetworkIssue } from "@ploydok/agent-proto"
import type { CaddyConfig } from "../caddy/types.js"
import { getSharedAgent } from "../debug/singletons.js"

export type ComponentStatus = "ok" | "degraded" | "down" | "unknown"

export interface HealthReport {
  ok: boolean
  version: string
  components: {
    db: { status: ComponentStatus; latency_ms?: number; error?: string }
    agent: {
      status: ComponentStatus
      socket?: string
      address?: string
      error?: string
    }
    caddy: { status: ComponentStatus; admin_url?: string; error?: string }
    ingress: {
      status: ComponentStatus
      network_issues: IngressNetworkIssue[]
      expected_http_routes: number
      missing_http_routes: string[]
      expected_tcp_proxies: number
      missing_tcp_proxies: string[]
      error?: string
    }
  }
}

const CADDY_ADMIN_URL = (
  process.env["CADDY_ADMIN_URL"] ?? "http://127.0.0.1:2020"
).replace(/\/$/, "")
const CADDY_CONFIG_URL = `${CADDY_ADMIN_URL}/config/`

function defaultAgentSocketPath(): string {
  const env = process.env["PLOYDOK_AGENT_SOCKET"]
  if (env) return env
  return process.env["NODE_ENV"] === "prod"
    ? "/run/ploydok/agent.sock"
    : "/tmp/ploydok/agent.sock"
}

function defaultAgentAddress(): string | null {
  return process.env["PLOYDOK_AGENT_ADDR"] ?? null
}

async function checkDb(db: Db): Promise<HealthReport["components"]["db"]> {
  const start = Date.now()
  try {
    await db.execute(sql`SELECT 1`)
    return { status: "ok", latency_ms: Date.now() - start }
  } catch (err) {
    return { status: "down", error: (err as Error).message }
  }
}

async function checkAgent(): Promise<HealthReport["components"]["agent"]> {
  const address = defaultAgentAddress()
  const socketPath = defaultAgentSocketPath()
  if (!address && !existsSync(socketPath)) {
    return { status: "down", socket: socketPath, error: "socket file not found" }
  }
  try {
    // This is a real gRPC round-trip. In production getSharedAgent builds an
    // mTLS channel from the API client certificate, so a listening TCP socket
    // without a valid agent identity can never make readiness green.
    await getSharedAgent().hostStats({}, 1_000)
    return address
      ? { status: "ok", address }
      : { status: "ok", socket: socketPath }
  } catch (err) {
    return {
      status: "down",
      ...(address ? { address } : { socket: socketPath }),
      error: (err as Error).message,
    }
  }
}

async function checkCaddy(): Promise<HealthReport["components"]["caddy"]> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1000)
    const res = await fetch(CADDY_CONFIG_URL, { signal: ctrl.signal })
    clearTimeout(t)
    if (res.ok) return { status: "ok", admin_url: CADDY_CONFIG_URL }
    return {
      status: "degraded",
      admin_url: CADDY_CONFIG_URL,
      error: `HTTP ${res.status}`,
    }
  } catch (err) {
    return {
      status: "down",
      admin_url: CADDY_CONFIG_URL,
      error: (err as Error).message,
    }
  }
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

async function fetchCaddyConfig(): Promise<CaddyConfig> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 1000)
  try {
    const res = await fetch(CADDY_CONFIG_URL, { signal: ctrl.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return ((await res.json()) as CaddyConfig | null) ?? {}
  } finally {
    clearTimeout(t)
  }
}

async function expectedIngressIds(db: Db): Promise<{
  httpRouteIds: string[]
  tcpProxyIds: string[]
}> {
  const [appRows, serviceRows, databaseRows] = await Promise.all([
    db
      .select({ id: apps.id })
      .from(apps)
      .where(
        and(
          inArray(apps.status, ["running", "restarting", "serving"]),
          isNotNull(apps.domain)
        )
      ),
    db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.status, "running"), isNotNull(services.domain))),
    db
      .select({ id: databases.id })
      .from(databases)
      .where(
        and(
          eq(databases.status, "running"),
          eq(databases.public_enabled, true),
          eq(databases.exposure_mode, "public_proxy"),
          isNotNull(databases.public_port)
        )
      ),
  ])

  return {
    httpRouteIds: [
      ...appRows.map((row) => `ploydok-${row.id}`),
      ...serviceRows.map((row) => `ploydok-${row.id}`),
    ],
    tcpProxyIds: databaseRows.map((row) => databaseTcpProxyServerId(row.id)),
  }
}

export async function checkIngress(
  db: Db,
  inspectNetworks = () => getSharedAgent().ingressStatus(),
  loadConfig = fetchCaddyConfig,
): Promise<HealthReport["components"]["ingress"]> {
  try {
    const [{ httpRouteIds, tcpProxyIds }, config, networkStatus] = await Promise.all([
      expectedIngressIds(db),
      loadConfig(),
      inspectNetworks(),
    ])

    const actualHttpRouteIds = new Set(
      Object.values(config.apps?.http?.servers ?? {}).flatMap((server) =>
        (server.routes ?? [])
          .map((route) => route["@id"])
          .filter((id): id is string => typeof id === "string")
      )
    )
    const actualTcpProxyIds = new Set(
      Object.keys(config.apps?.layer4?.servers ?? {})
    )

    const missingHttpRoutes = httpRouteIds.filter(
      (id) => !actualHttpRouteIds.has(id)
    )
    const missingTcpProxies = tcpProxyIds.filter(
      (id) => !actualTcpProxyIds.has(id)
    )
    const hasMissing =
      missingHttpRoutes.length > 0 || missingTcpProxies.length > 0

    return {
      status: hasMissing || networkStatus.issues.length > 0 ? "degraded" : "ok",
      network_issues: networkStatus.issues,
      expected_http_routes: httpRouteIds.length,
      missing_http_routes: missingHttpRoutes,
      expected_tcp_proxies: tcpProxyIds.length,
      missing_tcp_proxies: missingTcpProxies,
    }
  } catch (err) {
    return {
      status: "down",
      network_issues: [],
      expected_http_routes: 0,
      missing_http_routes: [],
      expected_tcp_proxies: 0,
      missing_tcp_proxies: [],
      error: (err as Error).message,
    }
  }
}

export async function buildHealthReport(
  db: Db,
  version: string
): Promise<HealthReport> {
  const [dbStatus, caddyStatus, ingressStatus, agentStatus] = await Promise.all(
    [checkDb(db), checkCaddy(), checkIngress(db), checkAgent()]
  )

  const ok =
    dbStatus.status === "ok" &&
    agentStatus.status !== "down" &&
    caddyStatus.status === "ok" &&
    ingressStatus.status === "ok"

  return {
    ok,
    version,
    components: {
      db: dbStatus,
      agent: agentStatus,
      caddy: caddyStatus,
      ingress: ingressStatus,
    },
  }
}

export interface PublicStatus {
  status: "operational" | "degraded" | "down"
  version: string
  components: {
    db: ComponentStatus
    agent: ComponentStatus
    caddy: ComponentStatus
  }
}

export async function buildPublicStatus(
  db: Db,
  version: string
): Promise<PublicStatus> {
  const [dbStatus, caddyStatus, agentStatus] = await Promise.all([
    checkDb(db),
    checkCaddy(),
    checkAgent(),
  ])

  const ok =
    dbStatus.status === "ok" &&
    agentStatus.status !== "down" &&
    caddyStatus.status !== "down"

  return {
    status: ok ? "operational" : "degraded",
    version,
    components: {
      db: dbStatus.status,
      agent: agentStatus.status,
      caddy: caddyStatus.status,
    },
  }
}
